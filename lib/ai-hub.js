// lib/ai-hub.js — Central AI Hub for Repair ASAP
// Handles: Webhook events, contact context FROM CRM, GPT-4o response generation
// MIGRATED: All GHL API calls replaced with CRM API (crm.asap.repair)

const { OpenAI } = require('openai');
const config = require('./config');
const { buildSystemPrompt, formatConversationHistory } = require('./knowledge-base');
const { logger } = require('./utils/log');

// CRM API base
const CRM_BASE_URL = process.env.CRM_BASE_URL || 'https://crm.asap.repair';
const CRM_API_KEY = process.env.CRM_API_KEY;

// ---------- Response Delay Config (seconds) ----------
const RESPONSE_DELAYS = {
    yelp: { first: [8, 15], subsequent: [10, 20] },
    thumbtack: { first: [3, 8], subsequent: [5, 12] },
    sms: { first: [5, 10], subsequent: [8, 15] },
    voice: { first: [0, 0], subsequent: [0, 0] },
    webchat: { first: [0, 0], subsequent: [0, 0] },
};

// Owner cooldown: if owner sent a message within this many ms, bot stays silent
const OWNER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------- CRM API Helper ----------

async function crmRequest(path) {
    if (!CRM_API_KEY) throw new Error('CRM_API_KEY not configured');

    const url = `${CRM_BASE_URL}${path}`;
    const res = await fetch(url, {
        headers: { 'x-api-key': CRM_API_KEY },
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`CRM API ${path} failed: ${res.status} ${errText}`);
    }
    return res.json();
}

async function crmPost(path, body) {
    if (!CRM_API_KEY) throw new Error('CRM_API_KEY not configured');

    const url = `${CRM_BASE_URL}${path}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'x-api-key': CRM_API_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`CRM POST ${path} failed: ${res.status} ${errText}`);
    }
    return res.json();
}

// ---------- Contact Context (CRM-only) ----------

/**
 * Get full contact context from CRM:
 * - Contact data (name, phone, email, source, notes)
 * - Conversation history (last 30 messages)
 * - Jobs
 */
async function getContactContext(contactId, phone) {
    const context = {
        name: null,
        phone: null,
        email: null,
        source: null,
        tags: [],
        notes: null,
        conversationHistory: [],
        conversationId: null,
        crmJobs: [],
        crmContactId: null,
    };

    try {
        // Build query — prefer contactId, fallback to phone
        let queryParam = '';
        if (phone) {
            queryParam = `phone=${encodeURIComponent(phone)}`;
        }
        // Note: GHL contactId won't match CRM contactId, so we rely on phone lookup
        // If phone is not available, we'll try the contactId as a CRM ID
        if (!phone && contactId) {
            queryParam = `contactId=${encodeURIComponent(contactId)}`;
        }

        const crm = await crmRequest(`/api/ai/context?${queryParam}`);

        if (!crm.found) {
            logger.warn('Contact not found in CRM', { contactId, phone });
            return context;
        }

        context.name = crm.contact?.name || null;
        context.phone = crm.contact?.phone || phone || null;
        context.email = crm.contact?.email || null;
        context.source = crm.contact?.source || null;
        context.notes = crm.contact?.notes || null;
        context.crmContactId = crm.contact?.id || null;

        // Map CRM messages to the format expected by ai-hub
        if (crm.recentMessages && crm.recentMessages.length > 0) {
            context.conversationHistory = crm.recentMessages.map(m => ({
                direction: m.direction,
                body: m.content || '',
                type: (m.channel || 'CRM').toUpperCase(),
                dateAdded: m.time,
                userId: m.sender === 'user' ? 'human' : null,
                source: m.sender === 'ai' ? 'workflow' : (m.sender === 'user' ? 'app' : null),
            }));
        }

        // Map CRM jobs
        if (crm.jobs && crm.jobs.length > 0) {
            context.crmJobs = crm.jobs;
        }

        logger.info('Contact context loaded from CRM', {
            contactId,
            phone,
            crmContactId: context.crmContactId,
            messages: context.conversationHistory.length,
            jobs: context.crmJobs.length,
        });

    } catch (err) {
        logger.error('Failed to get contact context from CRM', { error: err.message, contactId, phone });
        // Don't throw — allow AI to respond with no context rather than failing entirely
    }

    return context;
}

// ---------- AI Response Generation ----------

/**
 * Generate AI response using GPT-4o with full context
 * Supports vision (image analysis) if attachments contain images
 */
async function generateAIResponse({ channel, contactContext, currentMessage, attachments }) {
    const openai = new OpenAI({ apiKey: config.openai.apiKey });
    const model = config.aiHub?.model || 'gpt-4o';

    // Build system prompt with KB + channel rules + contact context
    let systemPrompt = await buildSystemPrompt(channel, contactContext);

    // Query LightRAG knowledge graph for richer context
    try {
        const ragUrl = process.env.LIGHTRAG_URL;
        const ragKey = process.env.LIGHTRAG_API_KEY;
        if (ragUrl) {
            const ragQuery = contactContext?.name
                ? `Customer ${contactContext.name} asks: ${currentMessage}`
                : currentMessage;
            const ragRes = await fetch(`${ragUrl}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': ragKey || '' },
                body: JSON.stringify({ org_id: process.env.CRM_ORG_ID || '', query: ragQuery, mode: 'mix', top_k: 10 }),
                signal: AbortSignal.timeout(3000),
            });
            if (ragRes.ok) {
                const ragData = await ragRes.json();
                if (ragData?.context && ragData.context.length > 10) {
                    systemPrompt += `\n\nKNOWLEDGE GRAPH CONTEXT (use to give more informed answers):\n${ragData.context.substring(0, 2000)}`;
                    logger.info('RAG context added', { chars: ragData.context.length, channel });
                }
            }
        }
    } catch (err) {
        logger.warn('LightRAG query failed, continuing without RAG context', { error: err.message });
    }

    // Build message history for the conversation
    const formattedHistory = formatConversationHistory(contactContext.conversationHistory || []);

    // Build the current user message (with optional image)
    const userMessageContent = [];
    userMessageContent.push({ type: 'text', text: currentMessage });

    // If there are image attachments, add them for Vision
    if (attachments && attachments.length > 0) {
        for (const att of attachments) {
            if (att.url && (att.contentType?.startsWith('image/') || att.url.match(/\.(jpg|jpeg|png|webp|gif)$/i))) {
                userMessageContent.push({
                    type: 'image_url',
                    image_url: { url: att.url, detail: 'low' },
                });
            }
        }
    }

    // Assemble messages array
    const messages = [
        { role: 'system', content: systemPrompt },
        ...formattedHistory,
        { role: 'user', content: userMessageContent.length === 1 ? currentMessage : userMessageContent },
    ];

    try {
        const completion = await openai.chat.completions.create({
            model,
            messages,
            max_tokens: 300,
            temperature: 0.7,
        });

        const response = completion.choices[0]?.message?.content || '';
        const actions = determineActions(response, contactContext);

        return {
            message: response.trim(),
            actions,
            usage: {
                promptTokens: completion.usage?.prompt_tokens,
                completionTokens: completion.usage?.completion_tokens,
                totalTokens: completion.usage?.total_tokens,
                model,
            },
        };
    } catch (err) {
        logger.error('OpenAI API error', { error: err.message });
        throw err;
    }
}

// ---------- Action Detection ----------

function determineActions(responseText, contactContext) {
    const actions = [];
    const lower = responseText.toLowerCase();

    if (lower.includes('team review') || lower.includes('get back to you personally') ||
        lower.includes('have our team') || lower.includes('someone will reach out')) {
        actions.push({ type: 'escalate', reason: 'AI escalated to human team' });
    }

    if (lower.includes('booked') || lower.includes('appointment') ||
        lower.includes('technician will confirm') || lower.includes('scheduled')) {
        actions.push({ type: 'notify_owner', reason: 'Booking mentioned in response' });
    }

    return actions;
}

// ---------- CRM Activity Logging ----------

/**
 * Log AI response and actions to CRM (replaces GHL tags/notes/custom fields)
 */
async function logToCRM(contactContext, channel, currentMessage, aiResponse, actions) {
    if (!contactContext.crmContactId) return;

    try {
        // Log the AI interaction as an activity
        await crmPost('/api/activity-log', {
            contactId: contactContext.crmContactId,
            type: 'ai_auto_reply',
            description: `[AI Hub/${channel}] Responded to: "${currentMessage.substring(0, 100)}" → "${aiResponse.substring(0, 100)}"`,
            metadata: JSON.stringify({
                channel,
                actions: actions.map(a => a.type),
                hasEscalation: actions.some(a => a.type === 'escalate'),
            }),
        });
    } catch (err) {
        logger.warn('Failed to log to CRM', { error: err.message });
    }
}

// ---------- Timing Helpers ----------

function randomDelay(min, max) {
    return min + Math.random() * (max - min);
}

async function applyHumanDelay(channel, isFirstBotMessage) {
    const delays = RESPONSE_DELAYS[channel] || RESPONSE_DELAYS.sms;
    const [min, max] = isFirstBotMessage ? delays.first : delays.subsequent;
    if (max <= 0) return 0;
    const delaySec = randomDelay(min, max);
    logger.info(`Applying human-like delay: ${delaySec.toFixed(1)}s`, { channel, isFirstBotMessage });
    await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
    return delaySec;
}

// ---------- Webhook Handler ----------

/**
 * Main webhook handler for GHL events
 * Receives: inbound message from any channel
 * Returns: AI response for GHL workflow to send
 *
 * SAFETY FEATURES:
 * 1. Skips outbound (owner) messages
 * 2. Detects owner takeover (stays silent when owner is actively chatting)
 * 3. Single-message AI firewall (12-hour session cache)
 * 4. Applies human-like response delay
 */
async function handleWebhook(event) {
    const {
        type,
        contactId,
        conversationId,
        direction,
        body: messageBody,
        message,
        channel,
        attachments,
        // GHL may pass phone in event metadata
        phone: eventPhone,
    } = event;

    // --- SAFETY CHECK 1: Skip outbound (owner) messages ---
    if (direction === 'outbound') {
        logger.info('Outbound message (owner), bot stays silent', { contactId });
        return { skipped: true, message: '', reason: 'Outbound message from owner/team' };
    }

    let rawBody = messageBody || message || '';
    let currentMessage = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);

    // 1. Get full contact context from CRM
    // Try to extract phone from event for CRM lookup
    const phone = eventPhone || event.phone || event.contactPhone || null;
    const contactContext = await getContactContext(contactId, phone);

    // --- SAFETY CHECK 1.5: Skip automated platform notifications & bots ---
    if (currentMessage) {
        const lowerMsg = currentMessage.toLowerCase();
        if (
            lowerMsg.includes('our automated system only responds to the words help, stop and start') ||
            lowerMsg.includes('thumbtack msg from') ||
            lowerMsg.includes('you have a new lead from thumbtack') ||
            lowerMsg.includes('reply stop to unsubscribe') ||
            lowerMsg.includes('reply stop to opt out')
        ) {
            logger.info('Automated platform notification detected, bot stays silent', { contactId });
            return { skipped: true, message: '', reason: 'Automated platform notification detected' };
        }
    }

    // Also block based on phone number if it's a known bot/notification number
    if (contactContext.phone && contactContext.phone.includes('4159186198')) {
        logger.info('Message from known Thumbtack bot number, staying silent', { contactId });
        return { skipped: true, message: '', reason: 'Message from known bot number' };
    }

    // For initial Thumbtack leads: pull the first inbound message from history
    if (!currentMessage && (!attachments || attachments.length === 0)) {
        if (channel === 'thumbtack') {
            const firstInbound = contactContext.conversationHistory.find(m => m.direction === 'inbound');
            if (firstInbound) {
                currentMessage = firstInbound.body || '';
                logger.info('Thumbtack initial lead — using first inbound message from history', {
                    contactId, messagePreview: currentMessage.substring(0, 100),
                });
            }
        }

        if (!currentMessage) {
            logger.warn('Empty message received, skipping', { contactId });
            return { skipped: true, message: '', reason: 'Empty message' };
        }
    }

    // --- SAFETY CHECK 2: Owner takeover detection ---
    const HUMAN_SOURCES = new Set(['app', 'web', 'mobile', 'manual', 'thumbtack', 'yelp', 'email', 'fb', 'ig', 'gmb']);
    const history = contactContext.conversationHistory;
    if (history.length > 0) {
        const lastHumanOutbound = [...history]
            .reverse()
            .find(m => {
                if (m.direction !== 'outbound') return false;
                if (m.userId) return true;
                if (m.source && HUMAN_SOURCES.has(m.source.toLowerCase())) return true;
                return false;
            });

        if (lastHumanOutbound && lastHumanOutbound.dateAdded) {
            const lastOwnerTime = new Date(lastHumanOutbound.dateAdded).getTime();
            const now = Date.now();
            const timeSinceOwner = now - lastOwnerTime;

            if (timeSinceOwner < OWNER_COOLDOWN_MS) {
                const minsAgo = Math.round(timeSinceOwner / 60000);
                const signal = lastHumanOutbound.userId ? `userId=${lastHumanOutbound.userId}` : `source=${lastHumanOutbound.source}`;
                logger.info(`Human owner active ${minsAgo}min ago (${signal}), bot stays silent`, { contactId });
                return {
                    skipped: true,
                    message: '',
                    reason: `Human owner was active ${minsAgo} minutes ago (cooldown: ${OWNER_COOLDOWN_MS / 60000}min)`,
                };
            }
        }
    }

    // --- SAFETY CHECK 3: Single-Message AI Firewall (12-hour session cache) ---
    const AI_COOLDOWN_MS = 12 * 60 * 60 * 1000;
    if (history.length > 0) {
        const lastBotOutbound = [...history]
            .reverse()
            .find(m => m.direction === 'outbound' && !m.userId && (!m.source || !HUMAN_SOURCES.has(m.source.toLowerCase())));

        if (lastBotOutbound && lastBotOutbound.dateAdded) {
            const lastBotTime = new Date(lastBotOutbound.dateAdded).getTime();
            const timeSinceBot = Date.now() - lastBotTime;

            if (timeSinceBot < AI_COOLDOWN_MS) {
                const hoursAgo = (timeSinceBot / (1000 * 60 * 60)).toFixed(1);
                logger.info(`AI already responded ${hoursAgo}h ago. Staying silent for ongoing conversation.`, { contactId });
                return {
                    skipped: true,
                    message: '',
                    reason: `AI already engaged in this conversation (responded ${hoursAgo} hours ago). Cooldown: 12h.`,
                };
            }
        }
    }

    // --- SAFETY CHECK 4: Human-like response delay ---
    const botMessageCount = history.filter(m => m.direction === 'outbound').length;
    const isFirstBotMessage = botMessageCount === 0;
    const appliedDelay = await applyHumanDelay(channel || 'sms', isFirstBotMessage);

    // 2. Generate AI response with full context
    const aiResult = await generateAIResponse({
        channel: channel || 'sms',
        contactContext,
        currentMessage,
        attachments,
    });

    // 3. Log AI interaction to CRM (replaces GHL tags/notes/custom fields)
    if (aiResult.message) {
        await logToCRM(contactContext, channel || 'sms', currentMessage, aiResult.message, aiResult.actions);
    }

    // NOTE: Message delivery is handled by GHL workflow's "Send Yelp Message" block.
    // The proxy just returns the AI message in the response body.
    // GHL accesses it via {{custom_webhook.1.body.aiResponse}}

    return {
        success: true,
        message: aiResult.message,
        actions: aiResult.actions,
        usage: aiResult.usage,
        timing: {
            delaySec: appliedDelay,
            isFirstBotMessage,
        },
    };
}

// ---------- Test Handler ----------

async function handleTest({ channel, customerName, message, contactId, dryRun, attachments }) {
    let contactContext;
    if (contactId) {
        contactContext = await getContactContext(contactId, null);
    } else {
        contactContext = {
            name: customerName || 'Test Customer',
            phone: '+1 (555) 000-0000',
            email: null,
            source: channel || 'test',
            tags: [],
            notes: null,
            conversationHistory: [],
        };
    }

    const aiResult = await generateAIResponse({
        channel: channel || 'yelp',
        contactContext,
        currentMessage: message || 'How much for TV mounting?',
        attachments: attachments || [],
    });

    return {
        dryRun: dryRun !== false,
        channel: channel || 'yelp',
        customerContext: {
            name: contactContext.name,
            source: contactContext.source,
            historyLength: contactContext.conversationHistory.length,
        },
        aiResponse: aiResult.message,
        actions: aiResult.actions,
        usage: aiResult.usage,
    };
}

module.exports = {
    handleWebhook,
    handleTest,
    getContactContext,
    generateAIResponse,
};

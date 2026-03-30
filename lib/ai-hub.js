// lib/ai-hub.js — Central AI Hub for Repair ASAP
// Handles: GHL webhook events, contact context, GPT-4o response generation, response delivery

const { OpenAI } = require('openai');
const config = require('./config');
const { buildSystemPrompt, formatConversationHistory } = require('./knowledge-base');
const { logger } = require('./utils/log');

// GHL API base
const GHL_API = 'https://services.leadconnectorhq.com';

// ---------- Response Delay Config (seconds) ----------
// [min, max] — randomized to appear human
// NOTE: GHL webhook timeout is ~30s. Total = delay + API calls (~3-5s) must be <30s
const RESPONSE_DELAYS = {
    yelp: { first: [8, 15], subsequent: [10, 20] },
    thumbtack: { first: [3, 8], subsequent: [5, 12] },
    sms: { first: [5, 10], subsequent: [8, 15] },
    voice: { first: [0, 0], subsequent: [0, 0] },
    webchat: { first: [0, 0], subsequent: [0, 0] },
};

// Owner cooldown: if owner sent a message within this many ms, bot stays silent
const OWNER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------- GHL API Helpers ----------

async function ghlRequest(method, path, body = null) {
    const token = config.prosbuddy.apiToken;
    if (!token) throw new Error('PROSBUDDY_API_TOKEN not configured');

    const url = `${GHL_API}${path}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
    };

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`GHL API ${method} ${path} failed: ${res.status} ${errText}`);
    }
    return res.json();
}

// ---------- Contact Context ----------

/**
 * Get full contact context from GHL + CRM:
 * - Contact data (name, phone, email, tags, source)
 * - Conversation history (last 20 messages from GHL + CRM history)
 * - CRM jobs and notes
 */
async function getContactContext(contactId) {
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
    };

    try {
        // 1. Get contact data from GHL
        const contact = await ghlRequest('GET', `/contacts/${contactId}`);
        const c = contact.contact || contact;
        context.name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null;
        context.phone = c.phone || null;
        context.email = c.email || null;
        context.source = c.source || null;
        context.tags = c.tags || [];

        // 2. Get conversations from GHL
        try {
            const conversations = await ghlRequest(
                'GET',
                `/conversations/search?contactId=${contactId}&limit=10`
            );
            if (conversations.conversations && conversations.conversations.length > 0) {
                context.conversationId = conversations.conversations[0].id;

                const allMessages = [];
                for (const conv of conversations.conversations) {
                    try {
                        const messages = await ghlRequest(
                            'GET',
                            `/conversations/${conv.id}/messages?limit=20`
                        );
                        if (messages.messages) {
                            allMessages.push(...messages.messages.map(m => ({
                                direction: m.direction,
                                body: m.body || m.message || '',
                                type: m.type,
                                dateAdded: m.dateAdded,
                                userId: m.userId || null,
                                source: m.source || null,
                                ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
                            })));
                        }
                    } catch (e) {
                        logger.warn('Could not fetch messages for conversation', { error: e.message, convId: conv.id });
                    }
                }

                if (allMessages.length > 0) {
                    context.conversationHistory = allMessages
                        .filter(m => m.body.length > 0)
                        .sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
                }
            }
        } catch (convErr) {
            logger.warn('Could not fetch conversation history', { error: convErr.message, contactId });
        }

        // 3. Get notes from GHL
        try {
            const notes = await ghlRequest('GET', `/contacts/${contactId}/notes`);
            if (notes.notes && notes.notes.length > 0) {
                context.notes = notes.notes.map(n => n.body).join('\n');
            }
        } catch (noteErr) {
            logger.warn('Could not fetch notes', { error: noteErr.message, contactId });
        }

        // 4. Enrich from CRM (imported chat history, jobs, notes)
        try {
            const crmApiKey = process.env.CRM_API_KEY;
            const crmBaseUrl = process.env.CRM_BASE_URL || 'https://crm.asap.repair';
            if (crmApiKey && context.phone) {
                const crmRes = await fetch(
                    `${crmBaseUrl}/api/ai/context?phone=${encodeURIComponent(context.phone)}`,
                    { headers: { 'x-api-key': crmApiKey } }
                );
                if (crmRes.ok) {
                    const crm = await crmRes.json();
                    if (crm.found) {
                        // Merge CRM messages into conversation history
                        if (crm.recentMessages && crm.recentMessages.length > 0) {
                            const crmMessages = crm.recentMessages.map(m => ({
                                direction: m.direction,
                                body: m.content || '',
                                type: m.channel?.toUpperCase() || 'CRM',
                                dateAdded: m.time,
                                userId: null,
                                source: 'crm',
                            }));
                            // Deduplicate by content+time proximity (within 1 minute)
                            const existing = new Set(context.conversationHistory.map(m =>
                                `${m.body.trim().substring(0, 50)}|${new Date(m.dateAdded).getTime()}`
                            ));
                            for (const cm of crmMessages) {
                                const key = `${cm.body.trim().substring(0, 50)}|${new Date(cm.dateAdded).getTime()}`;
                                // Check if similar message exists within 60s window
                                const isDupe = [...existing].some(ex => {
                                    const [exBody, exTime] = ex.split('|');
                                    return exBody === cm.body.trim().substring(0, 50) &&
                                        Math.abs(parseInt(exTime) - new Date(cm.dateAdded).getTime()) < 60000;
                                });
                                if (!isDupe && cm.body.length > 0) {
                                    context.conversationHistory.push(cm);
                                }
                            }
                            // Re-sort after merge
                            context.conversationHistory.sort((a, b) =>
                                new Date(a.dateAdded) - new Date(b.dateAdded)
                            );
                        }
                        // Add CRM jobs context
                        if (crm.jobs && crm.jobs.length > 0) {
                            context.crmJobs = crm.jobs;
                        }
                        // Merge CRM notes if GHL notes are empty
                        if (!context.notes && crm.contact?.notes) {
                            context.notes = crm.contact.notes;
                        }
                        logger.info('CRM context enriched', {
                            contactId,
                            crmMessages: crm.messageCount,
                            crmJobs: crm.jobs?.length || 0,
                        });
                    }
                }
            }
        } catch (crmErr) {
            logger.warn('Could not enrich from CRM', { error: crmErr.message, contactId });
        }

    } catch (err) {
        logger.error('Failed to get contact context', { error: err.message, contactId });
        throw err;
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
    const systemPrompt = await buildSystemPrompt(channel, contactContext);

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
                    image_url: { url: att.url, detail: 'low' }, // 'low' for cost efficiency
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

        // Determine actions from the response
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

    // Detect escalation
    if (lower.includes('team review') || lower.includes('get back to you personally') ||
        lower.includes('have our team') || lower.includes('someone will reach out')) {
        actions.push({ type: 'escalate', reason: 'AI escalated to human team' });
    }

    // Detect booking confirmation
    if (lower.includes('booked') || lower.includes('appointment') ||
        lower.includes('technician will confirm') || lower.includes('scheduled')) {
        actions.push({ type: 'notify_owner', reason: 'Booking mentioned in response' });
    }

    // Tag updates based on conversation stage
    if (contactContext && !contactContext.tags?.includes('AI-Engaged')) {
        actions.push({ type: 'add_tag', tag: 'AI-Engaged' });
    }

    return actions;
}

// ---------- Response Delivery ----------

/**
 * Send the AI-generated response back through GHL
 */
async function sendResponse({ contactId, conversationId, channel, message }) {
    try {
        // Send message through GHL Conversations API
        const result = await ghlRequest('POST', `/conversations/messages`, {
            type: channel === 'yelp' ? 'Yelp' : 'SMS',
            contactId,
            conversationId,
            message,
        });

        logger.info('Response sent via GHL', { contactId, channel, messageId: result.messageId });
        return result;
    } catch (err) {
        logger.error('Failed to send response', { error: err.message, contactId, channel });
        throw err;
    }
}

/**
 * Execute follow-up actions (tags, notes, notifications)
 */
async function executeActions(contactId, actions) {
    for (const action of actions) {
        try {
            switch (action.type) {
                case 'add_tag':
                    await ghlRequest('POST', `/contacts/${contactId}/tags`, {
                        tags: [action.tag],
                    });
                    logger.info('Tag added', { contactId, tag: action.tag });
                    break;

                case 'add_note':
                    await ghlRequest('POST', `/contacts/${contactId}/notes`, {
                        body: action.note,
                    });
                    break;

                case 'escalate':
                case 'notify_owner':
                    // Add a note so Nikita sees it in GHL
                    await ghlRequest('POST', `/contacts/${contactId}/notes`, {
                        body: `[AI HUB] ${action.reason}. Manual follow-up needed.`,
                    });
                    logger.info('Owner notified', { contactId, reason: action.reason });
                    break;
            }
        } catch (err) {
            logger.warn('Action execution failed', { action, error: err.message });
        }
    }
}

// ---------- Voice AI Sync (Shared Brain) ----------

/**
 * Generates a short summary of the conversation for the Voice AI to read,
 * and saves it to a Custom Field in GHL.
 */
async function syncVoiceAIContext(contactId, contactContext, currentMessage, aiResponse) {
    try {
        const openai = new OpenAI({ apiKey: config.openai.apiKey });
        // Take the last 6 messages for context to keep it concise and cheap
        const recentHistory = (contactContext.conversationHistory || []).slice(-6);
        const formattedHistory = formatConversationHistory(recentHistory);

        const messages = [
            ...formattedHistory,
            { role: 'user', content: currentMessage },
            { role: 'assistant', content: aiResponse },
            {
                role: 'system',
                content: 'Summarize the current state of this conversation in 1-3 sentences. Focus strictly on the client\'s needs, quoted prices, and scheduling status. Do not include greetings. This summary will be read by a Voice AI agent before it calls the client.'
            }
        ];

        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo', // Fast and cheap for summarization
            messages,
            max_tokens: 150,
            temperature: 0.3,
        });

        const summary = completion.choices[0]?.message?.content || '';
        if (!summary) return;

        const locationId = config.prosbuddy.locationId;
        if (!locationId) {
            logger.warn('PROSBUDDY_LOCATION_ID missing, skipping Voice AI sync');
            return;
        }

        // Fetch custom fields to find the ID
        const fieldsResponse = await ghlRequest('GET', `/locations/${locationId}/customFields`);
        let contextField = fieldsResponse.customFields?.find(f => f.name === 'AI Chat Context' || f.fieldKey === 'contact.ai_chat_context');

        if (!contextField) {
            // Create it if it doesn't exist
            const newField = await ghlRequest('POST', `/locations/${locationId}/customFields`, {
                name: 'AI Chat Context',
                dataType: 'LARGE_TEXT',
            });
            contextField = newField.customField || newField;
            logger.info('Created Custom Field "AI Chat Context" for Voice AI sync', { fieldId: contextField?.id });
        }

        if (contextField && contextField.id) {
            await ghlRequest('PUT', `/contacts/${contactId}`, {
                customFields: [
                    {
                        id: contextField.id,
                        key: contextField.fieldKey,
                        field_value: summary
                    }
                ]
            });
            logger.info('Voice AI context synced successfully', { contactId });
        }
    } catch (err) {
        logger.error('Failed to sync Voice AI context', { error: err.message, contactId });
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
 * Returns: AI response sent back to customer
 *
 * SAFETY FEATURES:
 * 1. Skips outbound (owner) messages
 * 2. Detects owner takeover (stays silent when owner is actively chatting)
 * 3. Applies human-like response delay
 */
async function handleWebhook(event) {
    const {
        type,           // 'InboundMessage' etc.
        contactId,
        conversationId,
        direction,      // 'inbound' = customer, 'outbound' = owner/team
        body: messageBody,
        message,
        channel,        // determined from event metadata
        attachments,
    } = event;

    // --- SAFETY CHECK 1: Skip outbound (owner) messages ---
    if (direction === 'outbound') {
        logger.info('Outbound message (owner), bot stays silent', { contactId });
        return { skipped: true, message: '', reason: 'Outbound message from owner/team' };
    }

    // Ensure string type to prevent OpenAI "got an object" error
    let rawBody = messageBody || message || '';
    let currentMessage = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);

    // 1. Get full contact context from GHL (needed before empty-message check for Thumbtack)
    const contactContext = await getContactContext(contactId);

    // --- SAFETY CHECK 1.5: Skip automated platform notifications & bots ---
    if (currentMessage) {
        const lowerMsg = currentMessage.toLowerCase();
        if (
            lowerMsg.includes('our automated system only responds to the words help, stop and start') || // Thumbtack automated SMS
            lowerMsg.includes('thumbtack msg from') || // Thumbtack lead notification SMS
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

    // For initial Thumbtack leads from GHL workflow: the webhook has no message body,
    // but the lead details are in conversation history (Thumbtack system message).
    // Pull the first inbound message as context for AI response generation.
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

        // If still no message after Thumbtack fallback, skip
        if (!currentMessage) {
            logger.warn('Empty message received, skipping', { contactId });
            return { skipped: true, message: '', reason: 'Empty message' };
        }
    }

    // --- SAFETY CHECK 2: Owner takeover detection ---
    // Determines if a HUMAN (not a bot/workflow) recently sent an outbound message.
    // Primary signal: userId set = definitely a human team member.
    // Fallback: source field indicates message originated from a human-facing interface.
    // EXCLUDED from human detection: 'workflow', 'api', 'system', 'campaign', 'automation'
    // (these are automated senders and must NOT silence the bot).
    // Note: native integrations like 'thumbtack', 'yelp', 'email' without user IDs
    // are assumed to be manual replies from the external apps.
    const HUMAN_SOURCES = new Set(['app', 'web', 'mobile', 'manual', 'thumbtack', 'yelp', 'email', 'fb', 'ig', 'gmb']);
    const history = contactContext.conversationHistory;
    if (history.length > 0) {
        const lastHumanOutbound = [...history]
            .reverse()
            .find(m => {
                if (m.direction !== 'outbound') return false;
                // Primary signal: userId set = human sent it
                if (m.userId) return true;
                // Fallback: source indicates a human-facing interface
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
    // User requirement: "Bot should answer only the FIRST client message, and ignore subsequent replies."
    // If the AI has ALREADY responded to this contact within the last 12 hours,
    // we assume this is an ongoing conversation and the AI should remain silent,
    // allowing the human team to take over without spamming the customer.
    const AI_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours
    if (history.length > 0) {
        // Find the last message sent by the system/bot (outbound, no userId)
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

    // 3. Message delivery:
    // NATIVE API VS WORKFLOW ROUTING: GHL's Conversations API (POST /conversations/messages) does NOT support 
    // channels like Yelp or Thumbtack natively without a phone number, causing 422 or 502 crashes.
    // For these restricted channels, we bypass API sending. The backend will just return the payload,
    // and the CRM workflow MUST catch the response and route it via native "Send Yelp Message" blocks.
    if (aiResult.message) {
        const API_SUPPORTED_CHANNELS = ['sms', 'email', 'fb', 'ig', 'gmb', 'webchat', 'live_chat'];
        if (API_SUPPORTED_CHANNELS.includes(channel)) {
            await sendResponse({
                contactId,
                conversationId,
                channel,
                message: aiResult.message
            });
        } else {
            logger.info(`Bypassing API delivery for ${channel}. Delegating message send back to CRM workflow blocks.`, { contactId });
        }

        // VOICE AI SYNC: Generate summary and save to GHL Custom Field
        logger.info('Generating Voice AI context summary', { contactId });
        await syncVoiceAIContext(contactId, contactContext, currentMessage, aiResult.message);
    }

    // 4. Execute follow-up actions (tags, notes, escalation notifications)
    if (aiResult.actions.length > 0) {
        await executeActions(contactId, aiResult.actions);
    }

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

/**
 * Test endpoint -- simulates a conversation without sending real messages
 */
async function handleTest({ channel, customerName, message, contactId, dryRun, attachments }) {
    // If contactId provided, get real context; otherwise simulate
    let contactContext;
    if (contactId) {
        contactContext = await getContactContext(contactId);
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

    // Generate AI response
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
            tags: contactContext.tags,
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
    sendResponse,
    executeActions,
};

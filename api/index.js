// api/index.js (VERSION: Conversational Lead Gen + Knowledge Base v2)

// --- Imports ---
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { appendLeadToSheet } = require('../lib/googleSheetService');

const { getAvailableSlots, bookAppointment } = require('../lib/calendarService');
const { logInfo, logError, logger } = require('../lib/utils/log');
const { normalizePhone } = require('../lib/utils/phone');
const { sendToTelegram, sendPhotoToTelegram, getTelegramChatId } = require('../lib/telegram');
const { enqueue } = require('../lib/message-queue');


const app = express();
let openai;

// --- OpenAI Init ---
try {
    if (config.openai.apiKey && config.openai.assistantId) {
        openai = new OpenAI({ apiKey: config.openai.apiKey });
        logger.info('OpenAI client initialized successfully.');
    } else {
        logger.error('OpenAI credentials missing');
    }
} catch (error) {
    logger.error('Failed to initialize OpenAI client', error);
}

// --- Middleware ---
app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-ID', req.id);
    logInfo(req, `${req.method} ${req.originalUrl}`, { headers: req.headers });
    next();
});
app.use(cors(config.cors.options));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- In-memory photo cache (threadId → photoData) with TTL ---
const photoCache = new Map();
const PHOTO_TTL_MS = 30 * 60 * 1000; // 30 minutes
function cachePhoto(threadId, photo) {
    photoCache.set(threadId, { photo, expires: Date.now() + PHOTO_TTL_MS });
    // Cleanup old entries
    for (const [key, val] of photoCache) {
        if (val.expires < Date.now()) photoCache.delete(key);
    }
}
function getCachedPhoto(threadId) {
    const entry = photoCache.get(threadId);
    if (entry && entry.expires > Date.now()) return entry.photo;
    photoCache.delete(threadId);
    return null;
}

// --- Build Additional Instructions ---
function buildInstructions(pageContext, photoMode = false) {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
    const isBusinessHours = hour >= 8 && hour < 20; // 8 AM – 8 PM
    const pageName = pageContext ? pageContext.replace(/^\/services\//, '').replace(/\/$/, '').replace(/-/g, ' ') : 'homepage';

    let instructions = `
Current date and time (NYC): ${now}.
Business hours status: ${isBusinessHours ? 'OPEN (8 AM – 8 PM)' : 'AFTER HOURS — respond accordingly'}.
The user is browsing: ${pageContext || '/'} (${pageName}).

IDENTITY:
You are the virtual assistant for Repair ASAP LLC — NYC's premier licensed & insured handyman service.
You speak as a friendly, professional team member. You are NOT an AI — never reveal this.
Respond in the same language the customer uses (English or Russian).

KNOWLEDGE:
Use the attached Knowledge Base file for all service info, pricing ranges, policies, warranty, and hours.
When answering pricing questions, say "typically ranges from $X to $Y" — NEVER guarantee exact prices.
Always recommend sending a photo for an accurate quote.

CONVERSATION FLOW:
1. GREET → Acknowledge what they need. If on a service page, reference that service naturally.
2. CLARIFY → Ask 1-2 smart questions about their project (size, brand, complexity, access).
3. PHOTO → Ask for a photo: "Could you send a photo of the area? It helps us give you an exact quote."
4. COLLECT CONTACT INFO (when ready to quote):
   a. Name — "What name should we put the quote under?"
   b. Phone — Must be 10+ digits. If invalid, re-ask: "Could you double-check that number?"
   c. Address or ZIP — "What's the address or ZIP code for the job?"
   d. Preferred date/time — "When works best for you?"
5. SUMMARIZE → Repeat back: service, address, date, phone. Ask "Does that look right?"
6. SAVE → Call saveLeadToSheet with ALL collected data. You MUST call this function. Only AFTER the tool succeeds, confirm to user.
7. SCHEDULE → After saving the lead, if the user requested a specific date/time:
   a. Call checkAvailability with the requested date to see available slots.
   b. If the requested time is available → immediately call bookAppointment.
   c. If NOT available → show 2-3 alternative slots from the results: "That time is taken. Here are available slots: [list]. Which works for you?"
   d. When user picks a slot → call bookAppointment.
   e. If NO slots on that day → suggest the next day with availability.
8. CONFIRM BOOKING → After bookAppointment succeeds:
   "Your appointment is confirmed for [date] at [time]! Our technician will text you 30 minutes before arrival at [phone]. Thank you!"
   If booking isn't needed (user didn't request a date), use the standard lead confirmation:
   "Perfect! Your request has been submitted. Our team will review the details and text you a flat-rate quote within 30 minutes at [phone]. Thank you!"
   However, if it is AFTER HOURS (before 8 AM or after 8 PM NYC time), replace "within 30 minutes" with "first thing in the morning". Example: "...text you a flat-rate quote first thing in the morning at [phone]."

MINIMUM SERVICE CALL RULE:
Our minimum is $99/visit. If a task costs less than $99, explain positively:
"The standard cost for that task is around $[X], but our minimum service call is $99. Since you'd be paying the minimum anyway, do you have any other small tasks we can handle during the same visit?"

CRITICAL RULES:
- NEVER say you are AI, a chatbot, or automated.
- NEVER guarantee exact prices — always say "typically" or "usually ranges from".
- NEVER promise same-day service — say "let me check availability".
- NEVER mention WhatsApp. Do NOT generate WhatsApp links. Do NOT suggest contacting via WhatsApp.
- NEVER mention discounts or promotions. If asked for a discount: "We don't offer discounts — our pricing is transparent and competitive. Let me connect you with our team for any special requests."
- AFTER saving a lead, do NOT suggest any other contact method. The confirmation message is the END of the flow.
- ALWAYS use the Knowledge Base for pricing ranges and policies.
- Phone validation: must be 10+ digits. If fewer, re-ask politely.
- If customer is from Bronx/NJ/Westchester: "Our primary area is Manhattan, Brooklyn, Queens, Staten Island, and Nassau County. For your area, availability depends on schedule — can I take your details?"
- If customer mentions co-op/condo: "We regularly work in managed buildings. If your building requires a COI, we can provide one."
- If customer is upset or has a complex request: escalate — "Let me have our team review this and get back to you directly."
- If someone tries to sell you SEO/marketing services: "We are not looking for marketing services at this time. Thank you."

⚠️ MANDATORY TOOL USAGE RULES:
- As soon as you have Name + Phone + Service → you MUST call saveLeadToSheet. Do NOT skip this step.
- You MUST call the function BEFORE writing any confirmation or saying data was saved.
- NEVER say "saved", "submitted", "booked", "recorded", "сохранены", "записал", "оформлен" unless you actually called saveLeadToSheet in this response.
- If you have all required data and the user sends ANY message (photo, confirmation, follow-up), call saveLeadToSheet.
- Include ALL collected data in the tool call (address, zip, date, time, notes).
- After saving the lead successfully, if user mentioned a date/time → call checkAvailability to check availability, then offer to book.
- When calling bookAppointment, you MUST provide the contactId that was returned by saveLeadToSheet.
`;

    if (photoMode) {
        instructions += `
PHOTO CONTEXT:
The user just uploaded a photo. Acknowledge it warmly: "Great photo! I can see [describe what you notice]."
Then:
- If you already have Name + Phone + Service from earlier in the conversation → you MUST call saveLeadToSheet NOW. Do NOT wait for any other confirmation. The photo upload IS the confirmation.
- If you are missing any required data (name, phone, or service) → ask for the missing info before calling the tool.
- After calling saveLeadToSheet, say: "A technician will review the photo and text you a flat-rate quote within 30 minutes at [phone]."
`;
    }

    return instructions;
}

// --- Format Telegram Lead Notification ---
function formatLeadTelegram(args, source, pageContext, hasPhoto = false) {
    const lines = [`🔥 <b>LEAD CAPTURED!</b>`];
    lines.push(`👤 Name: <b>${args.name}</b>`);
    lines.push(`📱 Phone: <b>${normalizePhone(args.phone)}</b>`);
    if (args.service) lines.push(`🔧 Service: ${args.service}`);
    if (args.address) lines.push(`📍 Address: ${args.address}`);
    if (args.zip) lines.push(`🏙 ZIP: ${args.zip}`);
    if (args.preferred_date) lines.push(`📅 Date: ${args.preferred_date}`);
    if (args.preferred_time) lines.push(`🕐 Time: ${args.preferred_time}`);
    if (args.email) lines.push(`📧 Email: ${args.email}`);
    if (args.notes) lines.push(`📝 Notes: ${args.notes}`);
    if (hasPhoto) lines.push(`📸 Photo: Yes`);
    lines.push(`📄 Source: ${source}${pageContext ? ` (${pageContext})` : ''}`);
    return lines.join('\n');
}

// --- Process Assistant Run (shared logic) ---
async function processAssistantRun(req, res, threadId, run, { source, pageContext, photoData }) {
    let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    const startTime = Date.now();
    let toolCalled = false;

    while (['queued', 'in_progress', 'requires_action'].includes(runStatus.status)) {
        if (Date.now() - startTime > 50000) {
            try { await openai.beta.threads.runs.cancel(threadId, run.id); } catch (e) { }
            await sendToTelegram(`⚠️ <b>Error:</b> Timeout waiting for AI response.`, 'leads');
            return res.status(504).json({ error: 'Timeout' });
        }

        if (runStatus.status === 'requires_action') {
            const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
            let toolOutputs = [];

            await Promise.all(toolCalls.map(async (toolCall) => {
                if (toolCall.function.name === 'saveLeadToSheet' || toolCall.function.name === 'saveBookingToSheet') {
                    toolCalled = true;
                    try {
                        const args = JSON.parse(toolCall.function.arguments);
                        const cleanPhone = normalizePhone(args.phone);

                        // Enhanced Telegram notification
                        const hasPhoto = !!photoData;
                        await sendToTelegram(formatLeadTelegram(args, source, pageContext, hasPhoto), 'leads');

                        const leadData = {
                            reqId: req.id,
                            timestamp: new Date().toISOString(),
                            source: source,
                            name: args.name,
                            phone: cleanPhone,
                            email: args.email || '',
                            service: args.service || '',
                            notes: [
                                args.address ? `Address: ${args.address}` : '',
                                args.zip ? `ZIP: ${args.zip}` : '',
                                args.preferred_date ? `Date: ${args.preferred_date}` : '',
                                args.preferred_time ? `Time: ${args.preferred_time}` : '',
                                args.notes || '',
                                hasPhoto ? 'Photo attached via chat' : '',
                                pageContext ? `Page: ${pageContext}` : ''
                            ].filter(Boolean).join(' | ')
                        };

                        // Send to CRM + Google Sheet
                        const crmUrl = process.env.NEW_CRM_WEBHOOK_URL || 'https://crm.asap.repair/api/webhooks/website';
                        const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
                        let crmOk = false;
                        let crmContactId = null;

                        const websitePayload = {
                            name: args.name,
                            phone: cleanPhone,
                            email: args.email || '',
                            zip: args.zip || '',
                            service: args.service || '',
                            date: args.preferred_date || '',
                            address: args.address || '',
                            message: [
                                `Source: Chatbot${pageContext ? ` (${pageContext})` : ''}`,
                                args.notes || '',
                                hasPhoto ? 'Photo attached via chat' : '',
                            ].filter(Boolean).join(' | '),
                        };
                        if (crmSecret) {
                            try {
                                const crmRes = await fetch(crmUrl, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'X-Webhook-Secret': crmSecret,
                                    },
                                    body: JSON.stringify(websitePayload),
                                });
                                if (crmRes.ok) {
                                    const crmData = await crmRes.json();
                                    crmOk = true;
                                    crmContactId = crmData.contactId || null;
                                } else {
                                    throw new Error(`CRM responded ${crmRes.status}`);
                                }
                            } catch (err) {
                                logger.error('CRM webhook error — queued for retry', { error: err.message });
                                enqueue({
                                    source: 'website',
                                    endpoint: '/api/webhooks/website',
                                    payload: websitePayload,
                                    clientMessage: args.notes || args.service || '',
                                    clientName: args.name,
                                });
                            }
                        }

                        const crmLog = crmOk ? '✅ CRM' : '❌ CRM';
                        const sheetResult = await appendLeadToSheet(req, leadData);
                        const sheetLog = sheetResult.success ? '✅ Sheet' : `❌ Sheet: ${sheetResult.error}`;
                        await sendToTelegram(`Status: ${crmLog} | ${sheetLog}`, 'activity');

                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'OK', message: 'Lead saved successfully.', contactId: crmContactId || null })
                        });
                    } catch (err) {
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'Error', message: err.message })
                        });
                    }
                }
                // --- checkAvailability tool ---
                else if (toolCall.function.name === 'checkAvailability') {
                    try {
                        const args = JSON.parse(toolCall.function.arguments);
                        const result = await getAvailableSlots(args.date, 1);
                        await sendToTelegram(`📅 <b>Checking availability:</b> ${args.date} → ${result.slots.length} slots available`, 'activity');
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({
                                date: args.date,
                                available_slots: result.slots,
                                total: result.slots.length,
                                error: result.error || null,
                            })
                        });
                    } catch (err) {
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ error: err.message, available_slots: [] })
                        });
                    }
                }
                // --- bookAppointment tool ---
                else if (toolCall.function.name === 'bookAppointment') {
                    try {
                        const args = JSON.parse(toolCall.function.arguments);
                        // Build ISO start time from date + time
                        const startTime = `${args.date}T${args.time}:00-05:00`;
                        const result = await bookAppointment({
                            contactId: args.contactId,
                            startTime,
                            service: args.service || 'Handyman Service',
                            address: args.address || '',
                            contactName: args.contactName || 'Customer',
                        });

                        if (result.success) {
                            await sendToTelegram(`📅 <b>APPOINTMENT BOOKED!</b>\n👤 ${args.contactName}\n📅 ${args.date} at ${args.time}\n🔧 ${args.service}\n📍 ${args.address || 'TBD'}`, 'leads');
                        } else {
                            await sendToTelegram(`⚠️ Booking failed: ${result.error}`, 'leads');
                        }

                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify(result)
                        });
                    } catch (err) {
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ success: false, error: err.message })
                        });
                    }
                }
            }));

            if (toolOutputs.length > 0) {
                runStatus = await openai.beta.threads.runs.submitToolOutputs(threadId, run.id, { tool_outputs: toolOutputs });
            }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    }

    if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(threadId, { limit: 1, order: 'desc' });
        const assistantMessage = messages.data.find(msg => msg.role === 'assistant');

        if (assistantMessage && assistantMessage.content[0]?.type === 'text') {
            const text = assistantMessage.content[0].text.value
                .replace(/【.*?】/g, '')
                .replace(/\[\d+:\d+†[^\]]+\]/g, '')
                .trim();

            // Lie detector: bot claims save but didn't call tool
            const lowerText = text.toLowerCase();
            const botClaimsSave = lowerText.includes('записал') || lowerText.includes('сохранил') ||
                lowerText.includes('оформил') || lowerText.includes('зарегистрировал') ||
                lowerText.includes('сохранен') || lowerText.includes('записан') ||
                lowerText.includes('оформлен') || lowerText.includes('зарегистрирован') ||
                lowerText.includes('передам') || lowerText.includes('были сохранены') ||
                lowerText.includes('booked') || lowerText.includes('saved') ||
                lowerText.includes('submitted') || lowerText.includes('recorded');

            if (botClaimsSave && !toolCalled) {
                await sendToTelegram(`⚠️ <b>WARNING:</b> Bot claimed save but did NOT call tool.`, 'leads');
            }

            const emoji = photoData ? '🤖📸' : '🤖';
            await sendToTelegram(`${emoji} <b>Bot:</b> ${text.substring(0, 500)}`, 'activity');

            return res.json({ message: text });
        }
    }

    return res.status(500).json({ error: `Run failed: ${runStatus.status}` });
}

// --- ROUTES ---

// Create thread
app.post('/api/thread', async (req, res) => {
    if (!openai) return res.status(500).json({ error: 'OpenAI not initialized' });
    try {
        const thread = await openai.beta.threads.create();
        await sendToTelegram(`🆕 <b>New Chat Started!</b>\nThread ID: <code>${thread.id}</code>`, 'activity');
        res.json({ threadId: thread.id });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create thread' });
    }
});

// Send message
app.post('/api/message', async (req, res) => {
    if (!openai) return res.status(500).json({ error: 'Config error' });

    try {
        const { threadId, message, pageContext } = req.body;
        if (!threadId || !message) return res.status(400).json({ error: 'Missing data' });

        await sendToTelegram(`👤 <b>User:</b> ${message.substring(0, 500)}`, 'activity');

        await openai.beta.threads.messages.create(threadId, { role: 'user', content: message });

        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: config.openai.assistantId,
            additional_instructions: buildInstructions(pageContext, false)
        });

        // Retrieve cached photo if one was uploaded earlier in this thread
        const cachedPhoto = getCachedPhoto(threadId);

        await processAssistantRun(req, res, threadId, run, {
            source: cachedPhoto ? 'Chatbot (Photo)' : 'Chatbot',
            pageContext: pageContext || '',
            photoData: cachedPhoto
        });

    } catch (error) {
        logError(req, '/api/message', 'Fatal error', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Chat photo upload — with Telegram forwarding
app.post('/api/chat-photo', async (req, res) => {
    if (!openai) return res.status(500).json({ error: 'OpenAI not initialized' });

    try {
        const { threadId, photo, pageContext } = req.body;
        if (!threadId || !photo || !photo.data) {
            return res.status(400).json({ error: 'Missing threadId or photo data' });
        }

        // Forward photo to Telegram immediately
        await sendToTelegram(`📸 <b>Photo received in chat!</b>\nThread: <code>${threadId}</code>`, 'leads');
        await sendPhotoToTelegram(photo.data, `📸 Chat photo from thread ${threadId}`, 'leads');

        // Cache photo for later use when saveLeadToSheet fires
        cachePhoto(threadId, photo);

        await openai.beta.threads.messages.create(threadId, {
            role: 'user',
            content: '[PHOTO UPLOADED] The user has attached a photo of their project. Acknowledge the photo and continue the conversation flow.'
        });

        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: config.openai.assistantId,
            additional_instructions: buildInstructions(pageContext, true)
        });

        await processAssistantRun(req, res, threadId, run, {
            source: 'Chatbot (Photo)',
            pageContext: pageContext || '',
            photoData: photo
        });

    } catch (error) {
        logError(req, '/api/chat-photo', 'Error', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Quote form
const handleQuoteSubmission = require('./quote');
app.post('/api/quote', handleQuoteSubmission);

// Calendar slots for quote form date picker
app.get('/api/calendar-slots', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }
        const result = await getAvailableSlots(date, 1);
        res.json({ date: result.date, slots: result.slots, raw: result.raw || [], error: result.error || null });
    } catch (error) {
        logError(req, '/api/calendar-slots', 'Error', error);
        res.status(500).json({ error: 'Failed to fetch slots' });
    }
});

// [DEPRECATED] Calendars endpoint — use CRM calendar
app.get('/api/admin/calendars', async (req, res) => {
    res.json({ message: 'Moved to CRM. Use crm.asap.repair/api/calendar-events' });
});

// Check if customer exists (now uses CRM instead of GHL)
app.get('/api/check-customer', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.json({ found: false });

        const crmApiKey = process.env.CRM_API_KEY;
        const crmBaseUrl = process.env.CRM_BASE_URL || 'https://crm.asap.repair';
        if (!crmApiKey) return res.json({ found: false });

        const crmRes = await fetch(
            `${crmBaseUrl}/api/ai/context?phone=${encodeURIComponent(phone)}`,
            { headers: { 'x-api-key': crmApiKey } }
        );
        if (!crmRes.ok) return res.json({ found: false });

        const data = await crmRes.json();
        if (data.found && data.contact) {
            res.json({ found: true, name: data.contact.name || '' });
        } else {
            res.json({ found: false });
        }
    } catch (error) {
        logError(req, '/api/check-customer', 'Error', error);
        res.json({ found: false });
    }
});

// --- ROUTE: AI Hub (Unified AI Brain) ---
const aiHub = require('../lib/ai-hub');

// --- ROUTE: Vapi.ai Custom Tools & Events ---
const vapiHub = require('./vapi');
app.use('/api/vapi', vapiHub);

// --- Deduplication + Burst Throttle ---
// Prevents double-response when both "Tag Added" + "Customer Replied" fire simultaneously.
// Also prevents back-to-back responses when a customer sends 2 messages within 90 seconds.
const processedMessages = new Map(); // dedupeKey -> timestamp
const lastBotReply = new Map();      // conversationId -> timestamp
const DEDUP_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const BURST_THROTTLE_MS = 90 * 1000;     // 90 seconds between bot replies per conversation

function makeDedupKey(channel, conversationId, messageId, body) {
    if (messageId) {
        // Scoped: channel:conversation:messageId prevents cross-channel collisions
        return `${channel || 'unknown'}:${conversationId || 'none'}:${messageId}`;
    }
    // Fallback: hash from content + minute bucket (rounds to nearest minute for dedup window)
    const minuteBucket = Math.floor(Date.now() / 60000);
    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const raw = `${channel}:${conversationId}:inbound:${bodyStr.slice(0, 80)}:${minuteBucket}`;
    // Simple djb2 hash — good enough for dedup, no crypto needed
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) + hash) ^ raw.charCodeAt(i);
    return `hash:${hash >>> 0}`;
}

function isDuplicate(key) {
    const now = Date.now();
    for (const [k, ts] of processedMessages) {
        if (now - ts > DEDUP_TTL_MS) processedMessages.delete(k);
    }
    if (processedMessages.has(key)) return true;
    processedMessages.set(key, now);
    return false;
}

function isBurstThrottled(conversationId) {
    if (!conversationId) return false;
    const last = lastBotReply.get(conversationId);
    return last && (Date.now() - last) < BURST_THROTTLE_MS;
}

function recordBotReply(conversationId) {
    if (conversationId) lastBotReply.set(conversationId, Date.now());
}

// Webhook endpoint - receives events from GHL workflows (SYNCHRONOUS)
// GHL workflow calls this, waits for response, then uses response body
// in the "Send Yelp message" action: {{webhook.response.message}}
app.post('/api/ai-hub/webhook', async (req, res) => {
    const context = '/api/ai-hub/webhook';
    logInfo(req, context, 'AI Hub webhook received', { body: req.body });

    try {
        const event = req.body;

        if (!event.contactId && !event.contact_id) {
            return res.status(400).json({ error: 'Missing contactId in webhook payload' });
        }

        // Normalize field names (GHL sends both formats)
        const normalizedEvent = {
            type: event.type || event.event || 'InboundMessage',
            contactId: event.contactId || event.contact_id,
            conversationId: event.conversationId || event.conversation_id,
            messageId: event.messageId || event.message_id || event.id || null,
            direction: event.direction || 'inbound',
            body: event.body || event.message || event.messageBody || '',
            channel: event.channel || detectChannel(event),
            attachments: event.attachments || [],
            // Phone for CRM lookup (GHL contactId ≠ CRM contactId)
            phone: event.phone || event.contact_phone || event.contactPhone ||
                   event.customData?.phone || event.customData?.contact_phone || null,
        };

        // Skip outbound (owner) messages — double guard (also checked in ai-hub.js)
        // MUST be before any GHL API calls to avoid wasted requests
        if (normalizedEvent.direction === 'outbound') {
            return res.json({ skipped: true, message: '', aiResponse: '', reason: 'Outbound message from owner/team' });
        }

        // ─── THUMBTACK BLOCK: CRM handles Thumbtack natively ────────
        // The CRM's /api/webhooks/thumbtack endpoint now generates and sends
        // AI auto-replies directly via the Thumbtack API + SMS bridge.
        // If we also respond here via GHL, we get 2-4x duplicate messages.
        // ALWAYS skip Thumbtack in the proxy — CRM is the single source of truth.
        if (normalizedEvent.channel === 'thumbtack') {
            logInfo(req, context, 'Thumbtack channel — CRM handles natively, proxy skipping', { contactId: normalizedEvent.contactId });
            return res.json({ skipped: true, message: '', aiResponse: '', reason: 'Thumbtack handled by CRM natively' });
        }

        // Dedup: prevent double-response when both "Contact Tag Added" + "Customer Replied" fire
        // for the same inbound message (race condition with two triggers + re-entry ON)
        const dedupKey = makeDedupKey(
            normalizedEvent.channel,
            normalizedEvent.conversationId,
            normalizedEvent.messageId,
            normalizedEvent.body
        );
        if (isDuplicate(dedupKey)) {
            logInfo(req, context, 'Duplicate message — skipping', { dedupKey });
            return res.json({ skipped: true, message: '', aiResponse: '', reason: 'Duplicate (dedup)' });
        }

        // Burst throttle: if bot already replied in this conversation within 90s, hold off.
        // Handles "Hi" + "Are you available?" sent back-to-back by the same customer.
        if (isBurstThrottled(normalizedEvent.conversationId)) {
            const secAgo = Math.round((Date.now() - lastBotReply.get(normalizedEvent.conversationId)) / 1000);
            logInfo(req, context, `Burst throttle — bot replied ${secAgo}s ago, skipping`, { conversationId: normalizedEvent.conversationId });
            return res.json({ skipped: true, message: '', aiResponse: '', reason: `Burst throttle (${secAgo}s since last reply)` });
        }

        // handleWebhook applies delay, checks owner cooldown, generates AI response
        // It does NOT send the message — GHL workflow handles delivery
        const result = await aiHub.handleWebhook(normalizedEvent);
        logInfo(req, context, 'AI Hub webhook processed', { result });

        // Record bot reply timestamp for burst throttle (only if we actually responded)
        if (!result.skipped && result.message) {
            recordBotReply(normalizedEvent.conversationId);
        }

        // Return response for GHL to use in "Send Yelp message" action
        // GHL Custom Webhook accesses: {{custom_webhook.1.body.aiResponse}}
        const aiMessage = result.message || '';
        res.json({
            success: !result.skipped,
            message: aiMessage,
            aiResponse: aiMessage,  // alias for GHL variable picker
            skipped: result.skipped || false,
            reason: result.reason || '',
        });
    } catch (error) {
        logError(req, context, 'AI Hub webhook error', { error: error.message });
        // Return empty message on error — GHL won't send anything
        res.json({ success: false, message: '', aiResponse: '', error: error.message });
    }
});

// Test endpoint - simulates a message for dry-run testing
app.post('/api/ai-hub/test', async (req, res) => {
    const context = '/api/ai-hub/test';
    logInfo(req, context, 'AI Hub test request', { body: req.body });

    try {
        const { channel, customer_name, message, contact_id, dry_run, attachments } = req.body;

        const result = await aiHub.handleTest({
            channel: channel || 'yelp',
            customerName: customer_name || 'Test Customer',
            message: message || 'How much for TV mounting?',
            contactId: contact_id || null,
            dryRun: dry_run !== false,
            attachments: attachments || [],
        });

        res.json(result);
    } catch (error) {
        logError(req, context, 'AI Hub test error', { error });
        res.status(500).json({ error: 'AI Hub test failed', message: error.message });
    }
});

function detectChannel(event) {
    const src = String(event.source || event.messageSource || event.messageType || event.type || '').toLowerCase();

    if (src.includes('yelp')) return 'yelp';
    if (src.includes('thumbtack')) return 'thumbtack';
    if (src.includes('email')) return 'email';
    if (src.includes('gmb') || src.includes('google')) return 'gmb';
    if (src.includes('fb') || src.includes('facebook')) return 'fb';
    if (src.includes('ig') || src.includes('instagram')) return 'ig';

    if (event.message && typeof event.message === 'object') {
        const mSrc = String(event.message.source || event.message.type || event.message.messageType || '').toLowerCase();
        if (mSrc.includes('yelp')) return 'yelp';
        if (mSrc.includes('thumbtack')) return 'thumbtack';
        if (mSrc.includes('email')) return 'email';
    }

    return 'sms'; // default
}

// --- ROUTE: Yelp via Zapier (Direct AI auto-reply) ---
// Zapier "New Consumer Message" → POST here → returns AI response → Zapier "Create Message"
app.post('/api/yelp-zapier', async (req, res) => {
    const context = '/api/yelp-zapier';
    logInfo(req, context, 'Yelp Zapier request received', { body: req.body });

    try {
        const {
            consumer_name, consumer_phone, consumer_email,
            message_content, message, lead_id, category, location,
            attachment_urls,
        } = req.body;

        const customerMessage = message_content || message || '';
        const customerName = consumer_name || 'Yelp Customer';

        // Parse attachment URLs — Zapier may send as string, comma-separated, or array
        let photoUrls = [];
        if (attachment_urls) {
            if (Array.isArray(attachment_urls)) {
                photoUrls = attachment_urls.filter(Boolean);
            } else if (typeof attachment_urls === 'string' && attachment_urls.trim()) {
                photoUrls = attachment_urls.split(',').map(u => u.trim()).filter(Boolean);
            }
        }

        if (!customerMessage && !category && photoUrls.length === 0) {
            return res.status(400).json({ error: 'Missing message_content or category' });
        }

        // Build context message if the message is empty but we have category
        const effectiveMessage = customerMessage ||
            `Hi, I'm looking for help with ${category || 'a handyman service'}. ${location ? `Location: ${location}` : ''}`;

        // Check if AI is paused for this contact in CRM
        const crmUrl = process.env.CRM_BASE_URL || 'https://crm.asap.repair';
        try {
            const pauseCheckUrl = `${crmUrl}/api/webhooks/yelp/check-pause?lead_id=${encodeURIComponent(lead_id || '')}&phone=${encodeURIComponent(consumer_phone || '')}`;
            const pauseRes = await fetch(pauseCheckUrl, {
                headers: { 'x-webhook-secret': process.env.NEW_CRM_WEBHOOK_SECRET || '' },
            });
            if (pauseRes.ok) {
                const pauseData = await pauseRes.json();
                if (pauseData.aiPaused || pauseData.dndAll) {
                    logInfo(req, context, `AI paused/DND for contact — skipping auto-reply`, { lead_id, customerName });
                    return res.json({ reply: '', skipped: true, reason: 'ai_paused' });
                }
            }
        } catch (pauseErr) {
            logger.warn('AI pause check failed (proceeding with reply)', { error: pauseErr.message });
        }

        // Fetch KB and generate AI response using the existing AI Hub
        const { buildSystemPrompt, formatConversationHistory } = require('../lib/knowledge-base');
        const { OpenAI: OpenAIClient } = require('openai');

        const ai = new OpenAIClient({ apiKey: config.openai.apiKey });

        const contactContext = {
            name: customerName,
            phone: consumer_phone || null,
            email: consumer_email || null,
            source: 'yelp',
            tags: ['yelp', 'zapier-auto'],
            notes: lead_id ? `Yelp Lead ID: ${lead_id}` : null,
            conversationHistory: [],
        };

        let systemPrompt = await buildSystemPrompt('yelp', contactContext);

        // Query LightRAG for additional context
        try {
            const ragUrl = process.env.LIGHTRAG_URL;
            const ragKey = process.env.LIGHTRAG_API_KEY;
            if (ragUrl) {
                const ragRes = await fetch(`${ragUrl}/query`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-API-Key': ragKey || '' },
                    body: JSON.stringify({ org_id: process.env.CRM_ORG_ID || '', query: `Yelp lead ${customerName}: ${effectiveMessage}`, mode: 'mix', top_k: 10 }),
                    signal: AbortSignal.timeout(3000),
                });
                if (ragRes.ok) {
                    const ragData = await ragRes.json();
                    if (ragData?.context && ragData.context.length > 10) {
                        systemPrompt += `\n\nKNOWLEDGE GRAPH CONTEXT:\n${ragData.context.substring(0, 1500)}`;
                    }
                }
            }
        } catch (ragErr) {
            logger.warn('LightRAG query failed for Yelp Zapier', { error: ragErr.message });
        }

        // Build user message — add vision blocks if customer sent photos
        let userContent;
        if (photoUrls.length > 0) {
            userContent = [
                {
                    type: 'text',
                    text: effectiveMessage
                        ? `${effectiveMessage}\n\nThe customer sent ${photoUrls.length} photo(s). Analyze them carefully and give a SPECIFIC price estimate based on what you see. Mention 1-2 specific details from the photos to show you looked. Do NOT say "technician will evaluate" — YOU are evaluating now. Move toward booking.`
                        : `The customer sent ${photoUrls.length} photo(s) for their ${category || 'service'} request. Analyze them and give a specific estimate.`,
                },
                ...photoUrls.map(url => ({
                    type: 'image_url',
                    image_url: { url, detail: 'low' },
                })),
            ];
        } else {
            userContent = effectiveMessage;
        }

        const completion = await ai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            max_tokens: 300,
            temperature: 0.7,
        });

        const aiResponse = completion.choices[0]?.message?.content?.trim() || '';

        // Log to Telegram
        await sendToTelegram(
            `📨 <b>Yelp (Zapier)</b>\n👤 ${customerName}\n💬 ${effectiveMessage.substring(0, 200)}\n🤖 ${aiResponse.substring(0, 300)}`,
            'activity'
        );

        // Sync lead to CRM — inline retry (2 attempts), then queue for background retry
        let crmSynced = false;
        const crmPayload = {
            name: customerName,
            phone: consumer_phone ? normalizePhone(consumer_phone) : null,
            email: consumer_email || null,
            service: category || null,
            message: effectiveMessage,
            lead_id: lead_id || null,
            ai_response: aiResponse,
            location: location || null,
            attachment_urls: photoUrls.length > 0 ? photoUrls : undefined,
        };

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                if (attempt > 1) await new Promise(r => setTimeout(r, 2000));
                const targetUrl = `${crmUrl}/api/webhooks/yelp`;
                logger.info(`CRM Yelp sync attempt ${attempt}`, { url: targetUrl, lead_id });
                const crmRes = await fetch(targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-webhook-secret': process.env.NEW_CRM_WEBHOOK_SECRET || '',
                    },
                    body: JSON.stringify(crmPayload),
                });

                if (!crmRes.ok) {
                    const errBody = await crmRes.text().catch(() => '(no body)');
                    logger.error(`CRM Yelp sync FAILED (attempt ${attempt})`, {
                        status: crmRes.status, body: errBody.substring(0, 300), lead_id, customerName,
                    });
                    continue;
                }
                const crmData = await crmRes.json();
                crmSynced = true;
                logger.info('CRM Yelp sync OK', { contactId: crmData.contactId, conversationId: crmData.conversationId });
                break;
            } catch (crmErr) {
                logger.error(`CRM Yelp sync EXCEPTION (attempt ${attempt})`, { error: crmErr.message, lead_id, customerName });
            }
        }

        if (!crmSynced) {
            enqueue({
                source: 'yelp',
                endpoint: '/api/webhooks/yelp',
                payload: crmPayload,
                aiResponse,
                clientMessage: effectiveMessage,
                clientName: customerName,
            });
            await sendToTelegram(
                `🚨 <b>LEAD QUEUED</b> (CRM down)\n` +
                `👤 ${customerName}\n` +
                `📱 ${consumer_phone || 'No phone'}\n` +
                `🆔 ${lead_id || 'No ID'}\n` +
                `🔧 ${category || effectiveMessage.substring(0, 80)}\n` +
                `ℹ️ AI reply was sent to Yelp. Payload queued for background retry every 5 min.`,
                'leads'
            );
        }

        // Send AI reply to Yelp via Zapier Catch Hook (replaces old Zapier Step 3)
        const zapierSendUrl = process.env.ZAPIER_YELP_SEND_WEBHOOK;
        if (zapierSendUrl && lead_id && aiResponse) {
            try {
                const zapRes = await fetch(zapierSendUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        lead_id: lead_id,
                        message: aiResponse,
                    }),
                });
                logger.info('Yelp reply sent via Catch Hook', { lead_id, status: zapRes.status });
            } catch (zapErr) {
                logger.warn('Yelp Catch Hook send failed', { error: zapErr.message });
            }
        }

        // Return response (Zapier Step 3 no longer needed)
        res.json({
            success: true,
            message: aiResponse,
            lead_id: lead_id || null,
            customer_name: customerName,
        });
    } catch (error) {
        logError(req, context, 'Yelp Zapier error', { error: error.message });
        // Return a safe fallback message so Zapier can still respond
        res.json({
            success: false,
            message: `Hi! Thank you for reaching out to Repair ASAP. We'd love to help! Could you share a few details about your project? Our team will get back to you with a quote shortly. You can also call us at (775) 310-7770.`,
            error: error.message,
        });
    }
});

// Health check
app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    nodeVersion: process.version,
    hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
    hasTelegramChatId: !!process.env.TELEGRAM_ADMIN_ID,
    envKeys: Object.keys(process.env).filter(k => k.startsWith('TELEGRAM') || k.startsWith('RAILWAY') || k === 'NODE_ENV')
}));

// --- Queue status endpoint (auth via CRM_API_KEY) ---
const { retryPending, getStatus: getQueueStatus } = require('../lib/message-queue');

app.get('/api/queue-status', (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;
    if (!apiKey || apiKey !== process.env.CRM_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json(getQueueStatus());
});

app.post('/api/queue-retry', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;
    if (!apiKey || apiKey !== process.env.CRM_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await retryPending();
    res.json(result);
});

// --- Retry cron: every 5 minutes ---
const cron = require('node-cron');
cron.schedule('*/5 * * * *', async () => {
    try {
        const result = await retryPending();
        if (result.delivered > 0 || result.failed > 0) {
            logger.info('[Queue Cron] Retry results', result);
            if (result.delivered > 0) {
                await sendToTelegram(
                    `✅ <b>Queue retry</b>: ${result.delivered} delivered, ${result.failed} failed, ${result.remaining} remaining`,
                    'activity'
                );
            }
            if (result.failed > 0) {
                await sendToTelegram(
                    `🚨 <b>Queue: ${result.failed} messages permanently failed</b> (3 attempts exhausted). Check /api/queue-status`,
                    'activity'
                );
            }
        }
    } catch (err) {
        logger.error('[Queue Cron] Error', { error: err.message });
    }
});

// Export app and useful utility functions for other modules (like vapi.js)
module.exports = {
    app,
    sendToTelegram,
    sendPhotoToTelegram,
    getTelegramChatId
};

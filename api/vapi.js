const express = require('express');
const { logInfo, logError, logger } = require('../lib/utils/log');
const { getAvailableSlots, bookAppointment } = require('../lib/calendarService');
const { sendToTelegram } = require('../lib/telegram');

const router = express.Router();

/**
 * Helper: Look up a contact in GHL by phone number
 */
async function lookupContactByPhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) return null;

    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    const locationId = process.env.PROSBUDDY_LOCATION_ID;
    if (!apiKey || !locationId) return null;

    const searchPhone = '+1' + digits.slice(-10);
    try {
        const resp = await fetch(
            `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(searchPhone)}`,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Version': '2021-07-28',
                },
            }
        );
        const data = await resp.json();
        const contact = data?.contact;
        if (contact && contact.id) {
            return {
                id: contact.id,
                name: contact.firstNameLowerCase ? (contact.firstName || contact.firstNameLowerCase) : (contact.contactName || ''),
                email: contact.email || '',
                address: contact.address1 ? `${contact.address1}${contact.city ? ', ' + contact.city : ''}` : '',
                // If we need custom fields, we could fetch them here or extract from standard fields
            };
        }
    } catch (error) {
        logger.error('Error looking up contact for Vapi', error);
    }
    return null;
}

/**
 * POST /api/vapi/webhook
 * Unified endpoint for Vapi Server Events (assistant-request, end-of-call-report, etc.)
 */
router.post('/webhook', async (req, res) => {
    try {
        const payload = req.body;
        const type = payload?.message?.type;
        logger.info(`Vapi Webhook Received: ${type}`);

        // 1. Assistant Request (Before Call Starts) - Inject Context
        if (type === 'assistant-request') {
            const customerNumber = payload.message?.call?.customer?.number;
            let firstMessage = `Hi! This is Repair ASAP. How can I help you today?`;
            let customerName = '';
            let customerAddress = '';

            if (customerNumber) {
                const contact = await lookupContactByPhone(customerNumber);
                if (contact && contact.name) {
                    customerName = contact.name;
                    customerAddress = contact.address || '';
                    firstMessage = `Hi ${contact.name}, this is Anna from Repair ASAP! How can I help you today?`;
                }
            }

            // Return the specific Assistant ID and inject context into the System Prompt via overrides
            return res.json({
                assistantId: "2d0ec368-7ab0-4b0e-a516-78157cb96b0c",
                assistantOverrides: {
                    firstMessage: firstMessage,
                    variableValues: {
                        name: customerName,
                        address: customerAddress
                    }
                }
            });
        }

        // 2. End of Call Report - Save Transcript and Notify
        if (type === 'end-of-call-report') {
            const callData = payload.message;
            const customerNumber = callData.call?.customer?.number;
            const transcript = callData.artifact?.transcript || callData.transcript || '';
            const recordingUrl = callData.artifact?.recordingUrl || callData.recordingUrl || '';
            const summary = callData.analysis?.summary || callData.summary || '';

            logger.info('Call ended', { customerNumber, summary });

            // Send notification to Telegram → Leads group (calls need immediate attention)
            let safeTranscript = transcript ? transcript.substring(0, 3800) : 'No transcript';
            if (transcript.length > 3800) safeTranscript += '... [Truncated due to Telegram limits]';

            const tgMessage = `📞 <b>Vapi AI Call Ended</b>\nPhone: ${customerNumber || 'Unknown'}\n\n<b>Summary:</b>\n${summary || 'No summary'}\n\n<b>Recording:</b>\n${recordingUrl || 'No recording'}\n\n<b>Transcript:</b>\n${safeTranscript}`;
            await sendToTelegram(tgMessage, 'leads');

            // Push a generic note to GHL CRM here, creating the contact if they don't exist
            if (customerNumber) {
                let contact = await lookupContactByPhone(customerNumber);
                let contactId = contact?.id;

                // Auto-create contact for callers who hung up before booking
                if (!contactId) {
                    const { sendLeadToCRM } = require('../lib/crmService');
                    const crmRes = await sendLeadToCRM({
                        name: 'Unknown Caller (Voice AI)',
                        phone: customerNumber,
                        service: 'General Inquiry',
                    });
                    if (crmRes.success) {
                        contactId = crmRes.contactId;
                    }
                }

                if (contactId) {
                    const apiKey = process.env.PROSBUDDY_API_TOKEN;
                    if (apiKey) {
                        try {
                            // 1. Add Note
                            await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${apiKey}`,
                                    'Content-Type': 'application/json',
                                    'Version': '2021-07-28'
                                },
                                body: JSON.stringify({
                                    body: `[Vapi AI Call]\nSummary: ${summary || 'None'}\nRecording: ${recordingUrl || 'None'}\nTranscript: ${transcript}`,
                                    userId: process.env.PROSBUDDY_LOCATION_ID
                                })
                            });

                            // 2. Add Internal Comment to Conversation history
                            await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${apiKey}`,
                                    'Content-Type': 'application/json',
                                    'Version': '2021-04-15'
                                },
                                body: JSON.stringify({
                                    type: 'InternalComment',
                                    contactId: contact.id,
                                    message: `📞 [Vapi AI Call Log]\nSummary: ${summary || 'None'}\nRecording: ${recordingUrl || 'None'}\nTranscript: ${transcript ? transcript.substring(0, 500) + '...' : ''}`
                                })
                            });
                        } catch (err) {
                            logger.error('Failed to add GHL note', err);
                        }
                    }
                }
            }

            // 3. Push transcript to Repair ASAP CRM
            if (customerNumber) {
                const crmBaseUrl = process.env.CRM_BASE_URL; // e.g. https://app.bazas.ai
                if (crmBaseUrl) {
                    try {
                        const durationSeconds = callData.call?.duration || callData.duration || 0;
                        const durationMin = Math.floor(durationSeconds / 60);
                        const durationSec = durationSeconds % 60;
                        const durationStr = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSeconds}s`;

                        const crmPayload = {
                            from: customerNumber,
                            callSid: callData.call?.id || '',
                            transcript: transcript || '',
                            summary: summary || '',
                            recordingUrl: recordingUrl || '',
                            duration: durationStr,
                            source: 'vapi',
                        };

                        const crmResponse = await fetch(`${crmBaseUrl}/api/twilio/voice/transcript`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(crmPayload),
                        });

                        if (crmResponse.ok) {
                            logger.info('VAPI transcript pushed to CRM', { customerNumber });
                        } else {
                            logger.warn('CRM transcript push failed', { status: crmResponse.status });
                        }
                    } catch (crmErr) {
                        logger.error('Failed to push VAPI transcript to CRM', crmErr);
                    }
                }
            }

            return res.json({ success: true });
        }

        // 3. Tool Calls - Handle transferToHuman and other function calls
        if (type === 'tool-calls') {
            const toolCalls = payload.message?.toolCalls || payload.message?.toolCallList || [];
            logger.info('Tool calls received', { count: toolCalls.length, tools: toolCalls.map(t => t?.function?.name || t?.name || 'unknown') });

            const results = [];

            for (const toolCall of toolCalls) {
                const functionName = toolCall?.function?.name || toolCall?.name || '';
                logger.info(`Processing tool call: ${functionName}`, { toolCallId: toolCall.id });

                if (functionName === 'transferToHuman') {
                    try {
                        let args = {};
                        try {
                            args = typeof toolCall.function.arguments === 'string'
                                ? JSON.parse(toolCall.function.arguments)
                                : (toolCall.function.arguments || {});
                        } catch (e) {
                            logger.error('Failed to parse transfer arguments', e);
                        }

                        const target = args.target || 'default';
                        const summary = args.summary || 'General inquiry';

                        // Extract the Twilio call SID from VAPI's call context
                        const callSid = payload.message?.call?.phoneCallProviderId
                            || payload.message?.call?.transport?.callSid
                            || payload.message?.call?.id;

                        // Get caller info
                        const callerPhone = payload.message?.call?.customer?.number || '';
                        const callerName = args.callerName
                            || payload.message?.call?.customer?.name
                            || (payload.message?.call?.assistantOverrides?.variableValues?.name)
                            || 'Unknown';

                        if (!callSid) {
                            logger.error('No call SID available for transfer');
                            results.push({
                                toolCallId: toolCall.id,
                                result: 'Sorry, I was unable to transfer the call due to a technical issue. Please ask the customer to call back or take their number.'
                            });
                            continue;
                        }

                        logger.info('Initiating warm transfer from webhook', { callSid, target, callerName, summary });

                        // Call the CRM transfer endpoint
                        const crmBaseUrl = process.env.CRM_BASE_URL || 'https://app.bazas.ai';
                        console.log(`[TRANSFER] Step 1: calling CRM at ${crmBaseUrl}/api/twilio/voice/transfer`);
                        console.log(`[TRANSFER] Payload:`, JSON.stringify({ callSid, target, callerName, callerPhone, summary }));
                        
                        const transferResponse = await fetch(`${crmBaseUrl}/api/twilio/voice/transfer`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                callSid,
                                target,
                                callerName,
                                callerPhone,
                                summary,
                            }),
                        });

                        console.log(`[TRANSFER] Step 2: CRM responded with status ${transferResponse.status}`);
                        
                        // Safe JSON parsing - read as text first
                        const responseText = await transferResponse.text();
                        console.log(`[TRANSFER] Step 3: CRM body (first 500 chars): ${responseText.substring(0, 500)}`);
                        
                        let transferData;
                        try {
                            transferData = JSON.parse(responseText);
                        } catch (parseErr) {
                            console.error(`[TRANSFER] CRM returned non-JSON: ${responseText.substring(0, 200)}`);
                            results.push({
                                toolCallId: toolCall.id,
                                result: `I was unable to transfer the call right now. Please let the customer know that ${target === 'nikita' ? 'Nikita' : 'our team'} will call them back shortly.`
                            });
                            continue;
                        }

                        if (transferResponse.ok && transferData.success) {
                            console.log(`[TRANSFER] SUCCESS: transferred to ${transferData.target}`);
                            const tgMsg = `📞➡️ <b>Call Transfer</b>\nCaller: ${callerName} (${callerPhone})\nTransferred to: ${transferData.target}\nReason: ${summary}`;
                            await sendToTelegram(tgMsg, 'leads');

                            results.push({
                                toolCallId: toolCall.id,
                                result: `Successfully connecting the caller to ${transferData.target}. The call is being transferred now.`
                            });
                        } else {
                            console.error(`[TRANSFER] FAILED: status=${transferResponse.status} data=${JSON.stringify(transferData)}`);
                            results.push({
                                toolCallId: toolCall.id,
                                result: `I was unable to transfer the call right now. Please let the customer know that ${target === 'nikita' ? 'Nikita' : 'our team'} will call them back shortly.`
                            });
                        }
                    } catch (e) {
                        console.error(`[TRANSFER] EXCEPTION: ${e.name}: ${e.message}`);
                        console.error(`[TRANSFER] STACK: ${e.stack}`);
                        results.push({
                            toolCallId: toolCall.id,
                            result: 'Sorry, there was a technical error with the transfer. Please take the customer\'s number.'
                        });
                    }
                }
                // Handle checkAvailability tool calls
                else if (functionName === 'checkAvailability') {
                    try {
                        let args = {};
                        try {
                            args = typeof toolCall.function.arguments === 'string'
                                ? JSON.parse(toolCall.function.arguments)
                                : (toolCall.function.arguments || {});
                        } catch (e) { }

                        const dateInput = args.date || args.day || '';
                        const parsedDate = parseNaturalDate(dateInput) || dateInput;
                        const result = await getAvailableSlots(parsedDate, args.numberOfDays || 1);
                        results.push({
                            toolCallId: toolCall.id,
                            result: JSON.stringify({
                                date: parsedDate,
                                available_slots: result.slots,
                                total: result.slots.length,
                            })
                        });
                    } catch (e) {
                        results.push({
                            toolCallId: toolCall.id,
                            result: JSON.stringify({ error: e.message, available_slots: [] })
                        });
                    }
                }
                // Handle bookAppointment tool calls
                else if (functionName === 'bookAppointment') {
                    try {
                        let args = {};
                        try {
                            args = typeof toolCall.function.arguments === 'string'
                                ? JSON.parse(toolCall.function.arguments)
                                : (toolCall.function.arguments || {});
                        } catch (e) { }

                        const startTime = `${args.date}T${args.time || '10:00'}:00-05:00`;
                        const callerPhone = payload.message?.call?.customer?.number || '';

                        // Look up contact to get contactId
                        let contactId = args.contactId;
                        if (!contactId && callerPhone) {
                            const contact = await lookupContactByPhone(callerPhone);
                            contactId = contact?.id;
                        }

                        const result = await bookAppointment({
                            contactId,
                            startTime,
                            service: args.service || 'Handyman Service',
                            address: args.address || '',
                            contactName: args.name || args.contactName || 'Customer',
                        });

                        if (result.success) {
                            const tgMsg = `📅 <b>BOOKED via Voice AI!</b>\n👤 ${args.name || 'Customer'}\n📅 ${args.date} at ${args.time}\n🔧 ${args.service || 'Handyman'}\n📍 ${args.address || 'TBD'}`;
                            await sendToTelegram(tgMsg, 'leads');
                        }

                        results.push({
                            toolCallId: toolCall.id,
                            result: JSON.stringify(result)
                        });
                    } catch (e) {
                        results.push({
                            toolCallId: toolCall.id,
                            result: JSON.stringify({ success: false, error: e.message })
                        });
                    }
                }
                // Unknown tool - acknowledge
                else {
                    logger.warn(`Unknown tool call: ${functionName}`);
                    results.push({
                        toolCallId: toolCall.id,
                        result: 'Tool not recognized.'
                    });
                }
            }

            return res.json({ results });
        }

        // 4. Other Events - Acknowledge safely
        return res.json({ success: true });

    } catch (e) {
        logError(req, '/api/vapi/webhook', 'Webhook processing failed', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Parses a date string or day of the week into a properly formatted YYYY-MM-DD in the future.
 */
function parseNaturalDate(input) {
    if (!input) return null;
    const lowerInput = String(input).toLowerCase().trim();
    // Get current NYC time
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

    if (lowerInput === 'today') return now.toISOString().split('T')[0];

    if (lowerInput === 'tomorrow') {
        const t = new Date(now);
        t.setDate(t.getDate() + 1);
        return t.toISOString().split('T')[0];
    }

    // Handle conversational broad week queries
    if (lowerInput === 'this week' || lowerInput === 'any day this week' || lowerInput === 'this weekend') {
        return now.toISOString().split('T')[0];
    }

    if (lowerInput === 'next week') {
        // Find next monday
        const t = new Date(now);
        let daysToMonday = 1 - t.getDay(); // 0 is Sunday
        if (daysToMonday <= 0) daysToMonday += 7;
        t.setDate(t.getDate() + daysToMonday);
        return t.toISOString().split('T')[0];
    }

    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDayIndex = now.getDay(); // 0 is Sunday

    let targetDayIndex = -1;
    for (let i = 0; i < days.length; i++) {
        if (lowerInput.includes(days[i])) {
            targetDayIndex = i;
            break;
        }
    }

    if (targetDayIndex !== -1) {
        let daysToAdd = targetDayIndex - currentDayIndex;
        if (daysToAdd <= 0) {
            daysToAdd += 7; // It's past this week's occurrence, move to next week
        }

        if (lowerInput.includes('next ')) {
            daysToAdd += 7;
        }

        const t = new Date(now);
        t.setDate(t.getDate() + daysToAdd);
        return t.toISOString().split('T')[0];
    }

    // We NO LONGER accept YYYY-MM-DD here. The routes will catch it and throw a strict error.
    return null;
}

/**
 * POST /api/vapi/calendar
 * Called by Vapi as a Custom Tool to check available slots.
 */
router.post('/calendar', async (req, res) => {
    logInfo(req, '/api/vapi/calendar', 'Vapi Calendar Request', { body: req.body });
    try {
        const { message } = req.body;
        // If it's a tool call, Vapi passes arguments inside message.toolCalls[0].function.arguments
        const toolCall = message?.toolCalls?.[0];
        if (!toolCall) return res.json({ error: 'No tool call provided' });

        let args = {};
        try {
            args = typeof toolCall.function.arguments === 'string'
                ? JSON.parse(toolCall.function.arguments)
                : (toolCall.function.arguments || {});
        } catch (e) {
            logger.error('Failed to parse calendar tool arguments', e);
        }

        const rawDate = args.date;

        // Strict Rejection of AI's YYYY-MM-DD hallucination habit
        if (typeof rawDate === 'string' && rawDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: DO NOT send dates in YYYY-MM-DD format. You MUST send the exact natural language string the user said, such as "this week", "next week", "Wednesday", or "tomorrow".'
                }]
            });
        }

        const date = parseNaturalDate(rawDate); // Supports "Wednesday", "this week", etc.

        if (!date) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: Could not understand the date format. Please pass a valid natural language timeframe like "this week", "next week", "Wednesday" or "tomorrow". DO NOT use YYYY-MM-DD.'
                }]
            });
        }

        const avail = await getAvailableSlots(date, 1);

        res.json({
            results: [{
                toolCallId: toolCall.id,
                result: `Available slots for ${date}: ${avail.slots.length > 0 ? avail.slots.join(', ') : 'None'}`
            }]
        });
    } catch (e) {
        logError(req, '/api/vapi/calendar', 'Calendar check failed', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/vapi/book
 * Called by Vapi Custom Tool to actually schedule the appointment.
 */
router.post('/book', async (req, res) => {
    logInfo(req, '/api/vapi/book', 'Vapi Booking Request', { body: req.body });
    try {
        const { message } = req.body;
        const toolCall = message?.toolCalls?.[0];
        if (!toolCall) return res.json({ error: 'No tool call provided' });

        let args = {};
        try {
            args = typeof toolCall.function.arguments === 'string'
                ? JSON.parse(toolCall.function.arguments)
                : (toolCall.function.arguments || {});
        } catch (e) {
            logger.error('Failed to parse book tool arguments', e);
        }

        const { time, service, address, name } = args;
        let { date, phone } = args;

        // Format or Auto-correct phone number
        if (phone) {
            // Strip everything except digits
            const digits = phone.replace(/\D/g, '');
            if (digits.length >= 10) {
                // Take the last 10 digits and prepend +1 formatting
                phone = '+1' + digits.slice(-10);
            } else {
                phone = null; // Formatting failed
            }
        }

        // Fallback to the actual incoming caller ID if AI didn't ask or provided garbage
        if (!phone && req.body.message?.call?.customer?.number) {
            phone = req.body.message.call.customer.number;
        }

        // Strict Rejection of AI's YYYY-MM-DD hallucination habit
        if (typeof date === 'string' && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: DO NOT send dates in YYYY-MM-DD format. You MUST send natural language like "this week", "next week", "Wednesday" or "tomorrow". Calculate the day of the week the user meant.'
                }]
            });
        }

        // Parse date from natural language
        date = parseNaturalDate(date);
        if (!date) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: Could not understand the date format. Please pass a valid natural language timeframe like "this week", "next week", "Wednesday" or "tomorrow".'
                }]
            });
        }

        // Ensure we have a contact ID to book against (upsert the contact)
        let contactId = null;
        if (phone) {
            const { sendLeadToCRM } = require('../lib/crmService');
            const crmRes = await sendLeadToCRM({
                name: name || 'Caller',
                phone: phone,
                service: service || 'Handyman',
                address: address || undefined
            });
            if (crmRes.success) {
                contactId = crmRes.contactId;
            }
        }

        if (!contactId) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: Could not find or create a contact to book against. Cannot book appointment.'
                }]
            });
        }

        const startTime = `${date}T${time}:00-05:00`;
        const bookingResult = await bookAppointment({
            contactId,
            startTime,
            service: service || 'Handyman Service',
            address: address || '',
            contactName: name || 'Customer'
        });

        const replyMsg = bookingResult.success
            ? `Successfully booked appointment for ${date} at ${time}.`
            : `Failed to book appointment: ${bookingResult.error}`;

        res.json({
            results: [{
                toolCallId: toolCall.id,
                result: replyMsg
            }]
        });

    } catch (e) {
        logError(req, '/api/vapi/book', 'Booking call failed', e);
        res.status(500).json({ error: e.message });
    }
});



/**
 * POST /api/vapi/outbound
 * Triggered by GoHighLevel Workflows (e.g., Abandoned form, "Call me" text)
 */
router.post('/outbound', async (req, res) => {
    try {
        const { firstName, phone, context } = req.body;
        logger.info('Received outbound call request from GHL', { firstName, phone, context });

        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        // 1. Format phone to strict +1XXXXXXXXXX (E.164)
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 10) {
            return res.status(400).json({ error: 'Invalid phone number length' });
        }
        const formattedPhone = '+1' + digits.slice(-10);

        // 2. Fetch VAPI Private Key
        const apiKey = process.env.VAPI_PRIVATE_API_KEY;
        if (!apiKey) {
            logger.error('VAPI_PRIVATE_API_KEY is not set in environment variables');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        // 3. Construct prompt overlay to give Anna context about WHY she is calling
        const overrideMessage = context
            ? `Hi ${firstName || 'there'}, this is Anna from Repair ASAP. You requested a callback regarding: ${context}. How can I help you today?`
            : `Hi ${firstName || 'there'}, this is Anna from Repair ASAP. How can I help you today?`;

        // 4. Hit Vapi Outbound API
        const vapiResponse = await fetch('https://api.vapi.ai/call/phone', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                assistantId: '2d0ec368-7ab0-4b0e-a516-78157cb96b0c',
                customer: {
                    number: formattedPhone,
                    name: firstName || 'Customer'
                },
                assistantOverrides: {
                    firstMessage: overrideMessage
                }
            })
        });

        if (!vapiResponse.ok) {
            const errData = await vapiResponse.text();
            logger.error('Vapi outbound call failed', errData);
            return res.status(vapiResponse.status).json({ error: 'Failed to initiate call via Vapi', details: errData });
        }

        const data = await vapiResponse.json();
        logger.info('Successfully initiated Vapi outbound call', { callId: data.id });
        res.status(200).json({ success: true, callId: data.id });

    } catch (e) {
        logError(req, '/api/vapi/outbound', 'Outbound webhook failed', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/vapi/transfer
 * Custom tool called by VAPI when Anna decides to transfer a call to a human.
 * Extracts the Twilio call SID and forwards to the CRM transfer endpoint.
 */
router.post('/transfer', async (req, res) => {
    logInfo(req, '/api/vapi/transfer', 'Transfer Request', { body: req.body });
    try {
        const { message } = req.body;
        const toolCall = message?.toolCalls?.[0];
        if (!toolCall) return res.json({ error: 'No tool call provided' });

        let args = {};
        try {
            args = typeof toolCall.function.arguments === 'string'
                ? JSON.parse(toolCall.function.arguments)
                : (toolCall.function.arguments || {});
        } catch (e) {
            logger.error('Failed to parse transfer tool arguments', e);
        }

        const target = args.target || 'default';
        const summary = args.summary || 'General inquiry';

        // Extract the Twilio call SID from VAPI's call context
        const callSid = message?.call?.phoneCallProviderId
            || message?.call?.transport?.callSid
            || message?.call?.id;

        // Get caller info
        const callerPhone = message?.call?.customer?.number || '';
        const callerName = args.callerName
            || message?.call?.customer?.name
            || (message?.call?.assistantOverrides?.variableValues?.name)
            || 'Unknown';

        if (!callSid) {
            logger.error('No call SID available for transfer');
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Sorry, I was unable to transfer the call due to a technical issue. Please ask the customer to call back or take their number and we will call them.'
                }]
            });
        }

        logger.info('Initiating warm transfer', { callSid, target, callerName, summary });

        // Call the CRM transfer endpoint
        const crmBaseUrl = process.env.CRM_BASE_URL || 'https://app.bazas.ai';
        const transferResponse = await fetch(`${crmBaseUrl}/api/twilio/voice/transfer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callSid,
                target,
                callerName,
                callerPhone,
                summary,
            }),
        });

        const transferData = await transferResponse.json();

        if (transferResponse.ok && transferData.success) {
            logger.info('Transfer initiated successfully', transferData);
            // Send Telegram notification about transfer
            const tgMsg = `📞➡️ <b>Call Transfer</b>\nCaller: ${callerName} (${callerPhone})\nTransferred to: ${transferData.target}\nReason: ${summary}`;
            await sendToTelegram(tgMsg, 'leads');

            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: `Successfully connecting the caller to ${transferData.target}. The call is being transferred now.`
                }]
            });
        } else {
            logger.error('Transfer failed', transferData);
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: `I was unable to transfer the call right now. Please let the customer know that ${target === 'nikita' ? 'Nikita' : 'Ayrat'} will call them back shortly.`
                }]
            });
        }

    } catch (e) {
        logError(req, '/api/vapi/transfer', 'Transfer failed', e);
        return res.json({
            results: [{
                toolCallId: req.body?.message?.toolCalls?.[0]?.id || 'unknown',
                result: 'Sorry, the transfer failed due to a technical error. Please take the customer\'s number and someone will call them back.'
            }]
        });
    }
});

module.exports = router;

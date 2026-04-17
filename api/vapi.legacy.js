const express = require('express');
const { logInfo, logError, logger } = require('../lib/utils/log');
const { getAvailableSlots, bookAppointment } = require('../lib/calendarService');
const { sendToTelegram } = require('../lib/telegram');
const { fetchKnowledgeBase } = require('../lib/knowledge-base');

const router = express.Router();

/**
 * Returns the current UTC offset string for America/New_York (e.g. "-05:00" or "-04:00").
 */
function getNYCOffset(dateStr) {
    const d = dateStr ? new Date(dateStr + 'T12:00:00Z') : new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'shortOffset',
    }).formatToParts(d);
    const offsetPart = parts.find(p => p.type === 'timeZoneName');
    if (offsetPart) {
        const m = offsetPart.value.match(/GMT([+-]\d+)/);
        if (m) {
            const hrs = parseInt(m[1], 10);
            return `${hrs < 0 ? '-' : '+'}${String(Math.abs(hrs)).padStart(2, '0')}:00`;
        }
    }
    return '-05:00';
}

/**
 * Build a voice-friendly pricing prompt from KB data.
 * This overrides the hardcoded pricing in Vapi's assistant config.
 */
function buildVoicePricingPrompt(kb) {
    if (!kb || !kb.services || kb.services.length === 0) {
        return ''; // No KB data — Vapi's built-in prompt will be used as fallback
    }

    const pricingLines = kb.services
        .map(s => `- ${s.name}: ${s.priceRange}`)
        .join('\n');

    const minimum = kb.policies?.minimumVisit || '$99';
    const warranty = kb.policies?.warranty || '1-year labor warranty, 60-day parts warranty';
    const payment = kb.policies?.payment || 'Cash, Zelle, Venmo, Card, Apple Pay, Google Pay';
    const doNotDo = kb.policies?.doNotDo || '';

    let prompt = `## PRICING UPDATE (from Knowledge Base — USE THESE PRICES, they override any older values)
${pricingLines}

Minimum visit charge: ${minimum}
Warranty: ${warranty}
Payment: ${payment}`;

    if (doNotDo) {
        prompt += `\n\nWe do NOT do: ${doNotDo}`;
    }

    // Include company hours if available
    if (kb.companyInfo?.hours) {
        prompt += `\n\nHours: Mon-Fri ${kb.companyInfo.hours.weekday || '9:00 AM - 7:00 PM'}, Sat-Sun ${kb.companyInfo.hours.weekend || '10:00 AM - 4:00 PM'}`;
    }

    return prompt;
}

/**
 * Helper: Look up a contact in CRM by phone number
 * Replaces GHL dependency — now all contact data comes from the CRM
 */
async function lookupContactByPhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) return null;

    const crmBaseUrl = process.env.CRM_BASE_URL || 'https://crm.asap.repair';
    const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
    if (!crmSecret) {
        logger.warn('[VAPI] No CRM_WEBHOOK_SECRET — cannot look up contacts');
        return null;
    }

    const searchPhone = '+1' + digits.slice(-10);
    try {
        const resp = await fetch(
            `${crmBaseUrl}/api/contacts/lookup?phone=${encodeURIComponent(searchPhone)}`,
            {
                headers: { 'X-Webhook-Secret': crmSecret },
                signal: AbortSignal.timeout(5000),
            }
        );
        if (!resp.ok) {
            logger.warn(`[VAPI] CRM lookup returned ${resp.status}`);
            return null;
        }
        const data = await resp.json();
        if (data?.found && data.id) {
            return {
                id: data.id,
                name: data.name || '',
                email: data.email || '',
                address: data.address || '',
                phone: data.phone || searchPhone,
                notes: data.notes || '',
                status: data.status || 'lead',
                jobCount: data.jobCount || 0,
                recentJobs: data.recentJobs || [],
                upcomingAppointments: data.upcomingAppointments || [],
            };
        }
    } catch (error) {
        logger.error('Error looking up contact in CRM for Vapi', error);
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

        // 1. Assistant Request (Before Call Starts) - Inject Context + KB Pricing
        if (type === 'assistant-request') {
            const customerNumber = payload.message?.call?.customer?.number;
            let firstMessage = `Repair ASAP, this is Anna. How can I help?`;
            let customerName = '';
            let customerAddress = '';
            let crmContextPrompt = '';
            let kbPricingPrompt = '';
            let ragContextPrompt = '';

            // Run CRM lookup, KB fetch, and RAG query in parallel
            const [contactResult, kbResult] = await Promise.allSettled([
                customerNumber ? lookupContactByPhone(customerNumber) : Promise.resolve(null),
                fetchKnowledgeBase().catch(() => null),
            ]);

            const contact = contactResult.status === 'fulfilled' ? contactResult.value : null;
            const kb = kbResult.status === 'fulfilled' ? kbResult.value : null;

            if (contact && contact.name) {
                customerName = contact.name;
                customerAddress = contact.address || '';
                const firstName = contact.name.split(' ')[0];

                const contextParts = [];
                contextParts.push(`## Caller Context (from CRM)`);
                contextParts.push(`- Name: ${contact.name}`);
                if (contact.address) contextParts.push(`- Address on file: ${contact.address}`);
                if (contact.notes) contextParts.push(`- Notes: ${contact.notes}`);
                contextParts.push(`- Status: ${contact.status || 'lead'} (${contact.jobCount || 0} total jobs)`);

                if (contact.recentJobs && contact.recentJobs.length > 0) {
                    contextParts.push(`\n### Recent Jobs:`);
                    contact.recentJobs.forEach((job, i) => {
                        contextParts.push(`${i + 1}. "${job.title}" — status: ${job.status}`);
                        if (job.description) contextParts.push(`   Description: ${job.description}`);
                        if (job.scheduledDate) contextParts.push(`   Scheduled: ${new Date(job.scheduledDate).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' })}${job.scheduledTime ? ' at ' + job.scheduledTime : ''}`);
                        if (job.address) contextParts.push(`   Job address: ${job.address}`);
                        if (job.notes) contextParts.push(`   Internal notes: ${job.notes}`);
                    });
                }

                if (contact.upcomingAppointments && contact.upcomingAppointments.length > 0) {
                    contextParts.push(`\n### Upcoming Appointments:`);
                    contact.upcomingAppointments.forEach((apt, i) => {
                        const date = new Date(apt.startTime).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
                        const time = new Date(apt.startTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
                        contextParts.push(`${i + 1}. "${apt.title}" — ${date} at ${time} (${apt.status})`);
                        if (apt.service) contextParts.push(`   Service: ${apt.service}`);
                        if (apt.address) contextParts.push(`   Address: ${apt.address}`);
                    });
                }

                contextParts.push(`\n### Instructions for returning callers:`);
                contextParts.push(`- Address the caller by first name: "${firstName}"`);
                contextParts.push(`- If they have active/scheduled jobs, reference them naturally. Example: "Are you calling about the [job title]?"`);
                contextParts.push(`- Never ask for information you already have (name, address, phone).`);
                contextParts.push(`- If same address as last time: "Same address as last time — [address], right?"`);

                crmContextPrompt = contextParts.join('\n');

                const activeJob = (contact.recentJobs || []).find(j => j.status === 'scheduled' || j.status === 'in_progress');
                if (activeJob) {
                    firstMessage = `Hi ${firstName}, this is Anna from Repair ASAP! Are you calling about the ${activeJob.title.toLowerCase()}?`;
                } else {
                    firstMessage = `Hi ${firstName}, this is Anna from Repair ASAP! How can I help you today?`;
                }

                logger.info(`[VAPI] CRM context loaded for ${firstName}: ${contact.jobCount} jobs, ${(contact.recentJobs || []).length} recent, ${(contact.upcomingAppointments || []).length} appointments`);
            }

            // Build KB pricing prompt (already resolved in parallel)
            kbPricingPrompt = buildVoicePricingPrompt(kb);
            if (kbPricingPrompt) {
                logger.info(`[VAPI] Injected KB pricing (${kb?.services?.length || 0} services) into Anna's prompt`);
            }

            // RAG query runs after contact lookup (needs customer name for better query)
            try {
                const ragUrl = process.env.LIGHTRAG_URL;
                const ragKey = process.env.LIGHTRAG_API_KEY;
                if (ragUrl) {
                    const ragQuery = customerName
                        ? `Caller ${customerName} from ${customerNumber}`
                        : `Incoming call from ${customerNumber}`;
                    const ragRes = await fetch(`${ragUrl}/query`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-API-Key': ragKey || '' },
                        body: JSON.stringify({ org_id: process.env.CRM_ORG_ID || '', query: ragQuery, mode: 'mix', top_k: 10 }),
                        signal: AbortSignal.timeout(3000),
                    });
                    if (ragRes.ok) {
                        const ragData = await ragRes.json();
                        if (ragData.context && ragData.context.length > 20) {
                            ragContextPrompt = `## Additional Context from Knowledge Graph\n${ragData.context.substring(0, 1500)}`;
                            logger.info(`[VAPI] RAG context loaded: ${ragData.context.length} chars`);
                        }
                    }
                }
            } catch (ragErr) {
                logger.warn('[VAPI] RAG query failed (non-critical):', ragErr.message);
            }

            const systemOverride = [
                crmContextPrompt,
                kbPricingPrompt,
                ragContextPrompt,
                `## CRITICAL: Call Transfer Protocol
When a customer asks to speak with a person, a manager, customer service, or anyone else:
1. FIRST say: "Sure, let me connect you right now. Please stay on the line — it will ring for just a moment."
2. THEN immediately call the transferToHuman tool. You ALWAYS have the ability to transfer calls.
3. NEVER say you cannot transfer calls. You CAN and MUST transfer when asked.
4. NEVER just silently transfer — always give a verbal warning first.
This is critical because customers hang up if they don't know a transfer is happening.`,
                `## Appointment Cancellation
When a customer asks to cancel an appointment:
1. Say "Let me look that up for you."
2. Call the cancelAppointment tool.
3. If successful, confirm the cancellation with the date and time.
4. If no appointment is found, apologize and offer to help with anything else.
NEVER say "I don't see any appointments" without first trying the cancelAppointment tool.`,
                `## Knowledge Base Lookup
When a customer asks about services, pricing, policies, or anything you're not 100% sure about:
1. Say "Let me check that for you" or "One moment."
2. Call the searchKnowledgeBase tool with their specific question.
3. Use the returned information to give an accurate answer.
Do NOT guess about pricing or service details — always verify with the tool.`,
                `## Email Collection
IMPORTANT: Do NOT ask customers to spell out their email address over the phone.
Instead, say: "I'll send you a quick text message where you can type in your email — much easier than spelling it out!"
Then proceed with the booking using the phone number. The email can be collected via SMS after the call.
If the customer insists on giving their email verbally, accept it, but always offer the SMS option first.`,
                `## Conversation Style Rules
- NEVER repeat the phrase "Thank you, I've made a note of that" more than once per call. Use varied acknowledgments: "Got it!", "Perfect!", "Noted!", "Great, thanks!"
- NEVER ask what timezone the caller is in. We operate in New York City — always assume Eastern Time.
- Keep responses concise and natural. Avoid long robotic scripts.
- Your name is Anna — NEVER confuse your own name with the caller's name.
- Always ask for the caller's name early if you don't already know it.
- If a caller corrects their name, acknowledge it and use the correct name going forward.`
            ].filter(Boolean).join('\n\n');

            return res.json({
                assistantId: "2d0ec368-7ab0-4b0e-a516-78157cb96b0c",
                assistantOverrides: {
                    firstMessage: firstMessage,
                    variableValues: {
                        name: customerName,
                        address: customerAddress
                    },
                    model: {
                        provider: "openai",
                        model: "gpt-4o-mini",
                        messages: [
                            {
                                role: "system",
                                content: systemOverride
                            }
                        ]
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

            // Save call data to CRM FIRST (critical path — must not be blocked by Telegram)
            if (customerNumber) {
                const crmBaseUrl = process.env.CRM_BASE_URL;
                if (crmBaseUrl) {
                    try {
                        let callerName = '';
                        try {
                            const contact = await lookupContactByPhone(customerNumber);
                            if (contact && contact.name) callerName = contact.name;
                        } catch (lookupErr) {
                            logger.warn('CRM contact lookup failed during call save', lookupErr.message);
                        }

                        const durationSeconds = callData.call?.duration || callData.duration || 0;
                        const durationMin = Math.floor(durationSeconds / 60);
                        const durationSec = durationSeconds % 60;
                        const durationStr = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSeconds}s`;

                        const crmPayload = {
                            from: customerNumber,
                            callerName: callerName || undefined,
                            callSid: callData.call?.id || '',
                            transcript: transcript || '',
                            summary: summary || '',
                            recordingUrl: recordingUrl || '',
                            duration: durationStr,
                            source: 'vapi',
                        };

                        const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
                        const crmResponse = await fetch(`${crmBaseUrl}/api/twilio/voice/transcript`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                ...(crmSecret ? { 'X-Webhook-Secret': crmSecret } : {}),
                            },
                            body: JSON.stringify(crmPayload),
                        });

                        if (crmResponse.ok) {
                            logger.info('VAPI transcript pushed to CRM', { customerNumber, callerName });
                        } else {
                            logger.warn('CRM transcript push failed', { status: crmResponse.status });
                        }
                    } catch (crmErr) {
                        logger.error('Failed to push VAPI transcript to CRM', crmErr);
                    }
                }
            }

            // Telegram notification is fire-and-forget (non-critical)
            let safeTranscript = transcript ? transcript.substring(0, 3800) : 'No transcript';
            if (transcript.length > 3800) safeTranscript += '... [Truncated due to Telegram limits]';

            const tgMessage = `📞 <b>Vapi AI Call Ended</b>\nPhone: ${customerNumber || 'Unknown'}\n\n<b>Summary:</b>\n${summary || 'No summary'}\n\n<b>Recording:</b>\n${recordingUrl || 'No recording'}\n\n<b>Transcript:</b>\n${safeTranscript}`;
            sendToTelegram(tgMessage, 'leads').catch(err => logger.warn('[VAPI] Telegram notification failed (non-critical)', err.message));

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

                        const crmBaseUrl = process.env.CRM_BASE_URL || 'https://app.bazas.ai';
                        const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
                        logger.info(`[TRANSFER] calling CRM transfer endpoint`);
                        
                        const transferResponse = await fetch(`${crmBaseUrl}/api/twilio/voice/transfer`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                ...(crmSecret ? { 'X-Webhook-Secret': crmSecret } : {}),
                            },
                            body: JSON.stringify({
                                callSid,
                                target,
                                callerName,
                                callerPhone,
                                summary,
                            }),
                        });

                        logger.info(`[TRANSFER] CRM responded with status ${transferResponse.status}`);
                        
                        const responseText = await transferResponse.text();
                        let transferData;
                        try {
                            transferData = JSON.parse(responseText);
                        } catch (parseErr) {
                            logger.error('[TRANSFER] CRM returned non-JSON response');
                            results.push({
                                toolCallId: toolCall.id,
                                result: `I was unable to transfer the call right now. Please let the customer know that our team will call them back shortly.`
                            });
                            continue;
                        }

                        if (transferResponse.ok && transferData.success) {
                            logger.info(`[TRANSFER] SUCCESS: transferred to ${transferData.target}`);
                            const tgMsg = `📞➡️ <b>Call Transfer</b>\nCaller: ${callerName}\nTransferred to: ${transferData.target}\nReason: ${summary}`;
                            sendToTelegram(tgMsg, 'leads').catch(err => logger.warn('[TRANSFER] Telegram notification failed', err.message));

                            results.push({
                                toolCallId: toolCall.id,
                                result: `Successfully connecting the caller to ${transferData.target}. The call is being transferred now.`
                            });
                        } else {
                            logger.error('[TRANSFER] CRM transfer failed', { status: transferResponse.status });
                            results.push({
                                toolCallId: toolCall.id,
                                result: `I was unable to transfer the call right now. Please let the customer know that our team will call them back shortly.`
                            });
                        }
                    } catch (e) {
                        logger.error('[TRANSFER] Exception during transfer', e);
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

                        const startTime = `${args.date}T${args.time || '10:00'}:00${getNYCOffset(args.date)}`;
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
                // Handle cancelAppointment tool calls
                else if (functionName === 'cancelAppointment') {
                    try {
                        const callerPhone = payload.message?.call?.customer?.number || '';
                        logger.info('[VAPI] cancelAppointment tool called', { callerPhone });

                        if (!callerPhone) {
                            results.push({
                                toolCallId: toolCall.id,
                                result: JSON.stringify({ success: false, error: 'No caller phone number available' })
                            });
                        } else {
                            const crmBaseUrl = process.env.CRM_BASE_URL || 'https://crm.asap.repair';
                            const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
                            const cancelRes = await fetch(`${crmBaseUrl}/api/vapi/cancel-appointment`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-Webhook-Secret': crmSecret,
                                },
                                body: JSON.stringify({ phone: callerPhone }),
                            });
                            const cancelData = await cancelRes.json();

                            if (cancelData.success) {
                                const tgMsg = `❌ <b>Appointment Cancelled via Voice AI</b>\nPhone: ${callerPhone}\nAppointment: ${cancelData.cancelled.title} on ${cancelData.cancelled.date} at ${cancelData.cancelled.time}`;
                                await sendToTelegram(tgMsg, 'leads');

                                results.push({
                                    toolCallId: toolCall.id,
                                    result: `Successfully cancelled the appointment on ${cancelData.cancelled.date} at ${cancelData.cancelled.time}. A confirmation SMS has been sent.`
                                });
                            } else {
                                results.push({
                                    toolCallId: toolCall.id,
                                    result: cancelData.error || 'No upcoming appointments found to cancel. The customer may not have a booked appointment.'
                                });
                            }
                        }
                    } catch (e) {
                        logger.error('[VAPI] cancelAppointment error', e);
                        results.push({
                            toolCallId: toolCall.id,
                            result: JSON.stringify({ success: false, error: e.message })
                        });
                    }
                }
                // Handle lookupCaller tool calls — returns caller context from CRM
                else if (functionName === 'lookupCaller') {
                    try {
                        const callerPhone = payload.message?.call?.customer?.number || '';
                        logger.info('[VAPI] lookupCaller tool called', { callerPhone });

                        if (callerPhone) {
                            const contact = await lookupContactByPhone(callerPhone);
                            if (contact && contact.name) {
                                logger.info('[VAPI] lookupCaller found contact', { name: contact.name, jobs: contact.jobCount });
                                const result = {
                                    found: true,
                                    name: contact.name,
                                    email: contact.email || '',
                                    address: contact.address || '',
                                    status: contact.status || 'lead',
                                    jobCount: contact.jobCount || 0,
                                    isReturningCustomer: (contact.jobCount || 0) > 0,
                                };
                                if (contact.recentJobs?.length > 0) {
                                    result.recentJobs = contact.recentJobs.map(j => `${j.title} (${j.status})`).join('; ');
                                }
                                if (contact.upcomingAppointments?.length > 0) {
                                    result.upcomingAppointments = contact.upcomingAppointments.map(a =>
                                        `${a.title} on ${new Date(a.startTime).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })}`
                                    ).join('; ');
                                }
                                results.push({ toolCallId: toolCall.id, result: JSON.stringify(result) });
                            } else {
                                results.push({
                                    toolCallId: toolCall.id,
                                    result: JSON.stringify({
                                        found: false,
                                        name: '',
                                        address: '',
                                        isReturningCustomer: false,
                                    })
                                });
                            }
                        } else {
                            results.push({
                                toolCallId: toolCall.id,
                                result: JSON.stringify({
                                    found: false,
                                    name: '',
                                    address: '',
                                    isReturningCustomer: false,
                                })
                            });
                        }
                    } catch (e) {
                        logger.error('[VAPI] lookupCaller error', e);
                        results.push({
                            toolCallId: toolCall.id,
                            result: JSON.stringify({ found: false, name: '', address: '', isReturningCustomer: false })
                        });
                    }
                }
                // Handle searchKnowledgeBase — mid-call RAG for specific questions
                else if (functionName === 'searchKnowledgeBase') {
                    try {
                        let args = {};
                        try {
                            args = typeof toolCall.function.arguments === 'string'
                                ? JSON.parse(toolCall.function.arguments)
                                : (toolCall.function.arguments || {});
                        } catch (e) { }

                        const question = args.question || args.query || '';
                        logger.info(`[VAPI] searchKnowledgeBase called: "${question}"`);

                        if (!question) {
                            results.push({ toolCallId: toolCall.id, result: 'No question provided.' });
                            continue;
                        }

                        // Try LightRAG first (fast vector search for voice), fall back to KB
                        let answer = '';
                        const ragUrl = process.env.LIGHTRAG_URL;
                        const ragKey = process.env.LIGHTRAG_API_KEY;

                        if (ragUrl) {
                            try {
                                const ragRes = await fetch(`${ragUrl}/query`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'X-API-Key': ragKey || '' },
                                    body: JSON.stringify({
                                        org_id: process.env.CRM_ORG_ID || '',
                                        query: question,
                                        mode: 'hybrid',
                                        top_k: 5,
                                        only_context: true,
                                    }),
                                    signal: AbortSignal.timeout(5000),
                                });
                                if (ragRes.ok) {
                                    const ragData = await ragRes.json();
                                    const ctx = ragData.context || ragData.response || '';
                                    if (ctx.length > 20) {
                                        answer = ctx.substring(0, 2000);
                                        logger.info(`[VAPI] RAG mid-call context: ${ctx.length} chars`);
                                    }
                                }
                            } catch (ragErr) {
                                logger.warn('[VAPI] Mid-call RAG failed, trying KB fallback', ragErr.message);
                            }
                        }

                        // Fallback: check KB pricing data
                        if (!answer) {
                            try {
                                const kb = await fetchKnowledgeBase();
                                if (kb) {
                                    const parts = [];
                                    if (kb.services) parts.push('Services: ' + kb.services.map(s => `${s.name}: ${s.priceRange}`).join('; '));
                                    if (kb.policies?.doNotDo) parts.push('We do NOT do: ' + kb.policies.doNotDo);
                                    if (kb.policies?.minimumVisit) parts.push('Minimum visit: ' + kb.policies.minimumVisit);
                                    if (kb.policies?.warranty) parts.push('Warranty: ' + kb.policies.warranty);
                                    answer = parts.join('\n');
                                }
                            } catch (kbErr) {
                                logger.warn('[VAPI] KB fallback also failed', kbErr.message);
                            }
                        }

                        results.push({
                            toolCallId: toolCall.id,
                            result: answer || 'I could not find specific information about that. Please offer to have a team member follow up with details.'
                        });
                    } catch (e) {
                        logger.error('[VAPI] searchKnowledgeBase error', e);
                        results.push({
                            toolCallId: toolCall.id,
                            result: 'Knowledge base lookup failed. Please offer general information or a callback.'
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

        // Ensure we have a contact ID to book against (upsert via CRM)
        let contactId = null;
        if (phone) {
            const crmUrl = process.env.NEW_CRM_WEBHOOK_URL || 'https://crm.asap.repair/api/webhooks/website';
            const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
            if (crmSecret) {
                try {
                    const crmRes = await fetch(crmUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Webhook-Secret': crmSecret,
                        },
                        body: JSON.stringify({
                            name: name || 'Caller',
                            phone: phone,
                            service: service || 'Handyman',
                            address: address || '',
                        }),
                    });
                    if (crmRes.ok) {
                        const data = await crmRes.json();
                        contactId = data.contactId || null;
                    }
                } catch (err) {
                    logger.error('CRM contact upsert error', { error: err.message });
                }
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

        const startTime = `${date}T${time}:00${getNYCOffset(date)}`;
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

        const crmBaseUrl = process.env.CRM_BASE_URL || 'https://app.bazas.ai';
        const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
        const transferResponse = await fetch(`${crmBaseUrl}/api/twilio/voice/transfer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(crmSecret ? { 'X-Webhook-Secret': crmSecret } : {}),
            },
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

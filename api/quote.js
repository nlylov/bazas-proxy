// api/quote.js — Quote Form API Route
// Handles form submissions, creates contact in CRM. Does NOT auto-book appointments.

const { logger } = require('../lib/utils/log');

/**
 * Main handler for POST /api/quote
 */
async function handleQuoteSubmission(req, res) {
    try {
        const { name, phone, email, zip, service, date, message, photos, time, address } = req.body;

        // Validate required fields
        if (!name || !phone) {
            return res.status(400).json({
                error: 'Name and phone are required'
            });
        }

        // Validate email format if provided
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                error: 'Invalid email format'
            });
        }

        // ═══════════════════════════════════════════════════════
        // STEP 1: Forward to CRM
        // ═══════════════════════════════════════════════════════
        const crmUrl = process.env.NEW_CRM_WEBHOOK_URL || 'https://crm.asap.repair/api/webhooks/website';
        const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
        let crmOk = false;
        let crmContactId = null;

        if (crmSecret) {
            try {
                const crmRes = await fetch(crmUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Secret': crmSecret,
                    },
                    body: JSON.stringify({ name, phone, email, zip, service, date, message, address }),
                });
                if (crmRes.ok) {
                    const crmData = await crmRes.json();
                    crmOk = true;
                    crmContactId = crmData.contactId || null;
                    logger.info('Lead sent to CRM', { name, phone, contactId: crmContactId });
                } else {
                    logger.error('CRM webhook failed', { status: crmRes.status });
                }
            } catch (err) {
                logger.error('CRM webhook error', { error: err.message });
            }
        }

        if (!crmOk) {
            logger.error('CRM failed, no fallback available');
            return res.status(500).json({
                error: 'Failed to submit quote. Please try again or call us.'
            });
        }

        // ═══════════════════════════════════════════════════════
        // STEP 2: Quote requests do NOT auto-book appointments
        // The date/time from the form is saved as a note in CRM.
        // An appointment should only be created after the customer
        // explicitly confirms a time (via call, SMS, or chat).
        // ═══════════════════════════════════════════════════════
        if (date || time) {
            logger.info('Quote form: preferred date/time noted (not auto-booking)', {
                date, time, name, phone,
            });
        }

        logger.info('Quote submission successful', {
            name, phone, service,
            crmOk,
        });
        return res.json({
            success: true,
            message: 'Quote request received successfully. We will get back to you shortly with a quote.',
            booked: false,
        });

    } catch (error) {
        logger.error('Quote submission error', error);
        if (!res.headersSent) {
            return res.status(500).json({
                error: 'Server error. Please try calling us at +1 (775) 310-7770.'
            });
        }
    }
}

module.exports = handleQuoteSubmission;

// api/quote.js — Quote Form API Route
// Handles form submissions, creates contact in CRM, and books appointments.

const { bookAppointment } = require('../lib/calendarService');
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
        // STEP 2: Calendar booking (uses CRM calendar)
        // ═══════════════════════════════════════════════════════
        let bookingResult = null;
        if (date && time) {
            try {
                bookingResult = await bookAppointment({
                    contactId: crmContactId || null,
                    startTime: time,
                    service: service || 'Handyman Service',
                    address: address || (zip ? `ZIP: ${zip}` : ''),
                    contactName: name,
                });
                if (bookingResult.success) {
                    logger.info('Quote form: appointment booked', {
                        appointmentId: bookingResult.appointmentId,
                        startTime: time,
                    });
                } else {
                    logger.error('Quote form: booking failed', { error: bookingResult.error });
                }
            } catch (bookErr) {
                logger.error('Quote form: booking error (non-critical)', bookErr);
            }
        }

        logger.info('Quote submission successful', {
            name, phone, service,
            crmOk,
            booked: bookingResult?.success || false,
        });
        return res.json({
            success: true,
            message: bookingResult?.success
                ? `Quote request received and appointment booked!`
                : 'Quote request received successfully',
            booked: bookingResult?.success || false,
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

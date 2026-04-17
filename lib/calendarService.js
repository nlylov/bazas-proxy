const { logger } = require('./utils/log');

// ═══════════════════════════════════════════════════
// Calendar Service — uses new CRM calendar API
// Replaces GHL calendar dependency
// ═══════════════════════════════════════════════════

const CRM_BASE_URL = process.env.NEW_CRM_WEBHOOK_URL
    ? new URL(process.env.NEW_CRM_WEBHOOK_URL).origin
    : 'https://crm.asap.repair';
const CRM_SECRET = process.env.NEW_CRM_WEBHOOK_SECRET;
const TIMEZONE = 'America/New_York';

/**
 * Get available slots for a given date (or multiple days).
 * @param {string} date - YYYY-MM-DD format (start date)
 * @param {number} [numberOfDays=1] - How many consecutive days to check
 * @returns {{ slots: string[], date: string, raw: string[], error?: string }}
 */
async function getAvailableSlots(date, numberOfDays = 1) {
    try {
        const days = Math.min(Math.max(numberOfDays, 1), 7);

        if (days === 1) {
            const url = `${CRM_BASE_URL}/api/calendar/slots?date=${date}`;
            const response = await fetch(url);
            const data = await response.json();

            if (!response.ok) {
                logger.error('Calendar slots error', { status: response.status, body: data });
                return { slots: [], date, raw: [], error: `Calendar API: ${response.status}` };
            }

            logger.info('Available slots from CRM', { date, count: data.slots?.length || 0 });
            return { slots: data.slots || [], raw: data.raw || [], date };
        }

        // Multi-day: fetch each day in parallel
        const startDate = new Date(date + 'T12:00:00Z');
        const fetches = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            const dateStr = d.toISOString().split('T')[0];
            fetches.push(
                fetch(`${CRM_BASE_URL}/api/calendar/slots?date=${dateStr}`)
                    .then(async r => ({ date: dateStr, data: await r.json(), ok: r.ok }))
                    .catch(e => ({ date: dateStr, data: { slots: [] }, ok: false, error: e.message }))
            );
        }

        const results = await Promise.all(fetches);
        const allSlots = [];
        const allRaw = [];

        for (const r of results) {
            if (r.ok && r.data.slots?.length > 0) {
                allSlots.push(...r.data.slots.map(s => `${r.date}: ${s}`));
                if (r.data.raw) allRaw.push(...r.data.raw);
            }
        }

        logger.info('Available slots from CRM (multi-day)', { startDate: date, days, totalSlots: allSlots.length });
        return { slots: allSlots, raw: allRaw, date };

    } catch (error) {
        logger.error('Calendar getAvailableSlots error', error);
        return { slots: [], date, raw: [], error: error.message };
    }
}

/**
 * Book an appointment in the CRM calendar.
 * @param {Object} params
 * @param {string} params.contactId - CRM contact ID (optional for website bookings)
 * @param {string} params.startTime - ISO 8601 datetime
 * @param {string} params.service - Service description
 * @param {string} params.address - Job address
 * @param {string} [params.contactName] - Name for the appointment title
 * @returns {{ success: boolean, appointmentId?: string, error?: string }}
 */
async function bookAppointment({ contactId, startTime, service, address, contactName }) {
    if (!CRM_SECRET) {
        return { success: false, error: 'CRM webhook secret not configured' };
    }

    try {
        const payload = {
            startTime,
            title: `Service for ${contactName || 'Customer'}`,
            service: service || 'Handyman Service',
            address: address || '',
            source: 'website',
        };

        // If we have a contactId from CRM, include it
        if (contactId) {
            payload.contactId = contactId;
        }

        const response = await fetch(`${CRM_BASE_URL}/api/calendar/appointments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Secret': CRM_SECRET,
            },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
            logger.error('Calendar booking error', { status: response.status, body: data });
            return { success: false, error: data.error || `Booking failed: ${response.status}` };
        }

        logger.info('Appointment booked via CRM', {
            appointmentId: data.appointmentId,
            startTime,
            service,
        });

        return {
            success: true,
            appointmentId: data.appointmentId,
            startTime: data.startTime,
            endTime: data.endTime,
        };

    } catch (error) {
        logger.error('Calendar bookAppointment error', error);
        return { success: false, error: error.message };
    }
}

module.exports = { getAvailableSlots, bookAppointment };

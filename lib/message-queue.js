/**
 * File-based message queue for failed CRM webhook deliveries.
 *
 * Stores payloads in /data/message-queue.jsonl (one JSON object per line).
 * On Railway, mount a persistent volume at /data to survive deploys.
 * Falls back to ./data/ in development.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('./utils/log');

const DATA_DIR = process.env.NODE_ENV === 'production'
    ? '/data'
    : path.resolve(__dirname, '../data');

const QUEUE_FILE = path.join(DATA_DIR, 'message-queue.jsonl');
const MAX_ATTEMPTS = 3;

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * Add a failed delivery to the queue.
 */
function enqueue({ source, payload, aiResponse, clientMessage, clientName, endpoint }) {
    ensureDir();
    const record = {
        id: uuidv4(),
        created_at: new Date().toISOString(),
        source: source || 'unknown',
        endpoint: endpoint || '/api/webhooks/yelp',
        payload,
        ai_response: aiResponse || null,
        client_message: clientMessage || null,
        client_name: clientName || null,
        status: 'pending',
        attempts: 0,
        last_attempt_at: null,
    };
    fs.appendFileSync(QUEUE_FILE, JSON.stringify(record) + '\n', 'utf-8');
    logger.info('[Queue] Enqueued failed delivery', { id: record.id, source, clientName });
    return record;
}

/**
 * Read all records from the queue file.
 */
function readAll() {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const lines = fs.readFileSync(QUEUE_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    const records = [];
    for (const line of lines) {
        try {
            records.push(JSON.parse(line));
        } catch {
            logger.warn('[Queue] Skipping malformed line');
        }
    }
    return records;
}

/**
 * Rewrite the entire queue file with updated records.
 */
function writeAll(records) {
    ensureDir();
    const content = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    fs.writeFileSync(QUEUE_FILE, content, 'utf-8');
}

/**
 * Get records by status.
 */
function getByStatus(status) {
    return readAll().filter(r => r.status === status);
}

/**
 * Update a record by ID (merge fields).
 */
function updateRecord(id, updates) {
    const records = readAll();
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return null;
    records[idx] = { ...records[idx], ...updates };
    writeAll(records);
    return records[idx];
}

/**
 * Retry all pending deliveries.
 * Returns { delivered, failed, remaining }.
 */
async function retryPending() {
    const pending = getByStatus('pending');
    if (pending.length === 0) return { delivered: 0, failed: 0, remaining: 0 };

    const crmUrl = process.env.CRM_BASE_URL || 'https://crm.asap.repair';
    const crmSecret = process.env.NEW_CRM_WEBHOOK_SECRET || '';
    let delivered = 0;
    let failed = 0;

    for (const record of pending) {
        const attempt = record.attempts + 1;
        try {
            const endpoint = record.endpoint || '/api/webhooks/yelp';
            const res = await fetch(`${crmUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-webhook-secret': crmSecret,
                    'X-Webhook-Secret': crmSecret,
                },
                body: JSON.stringify(record.payload),
            });

            if (res.ok) {
                updateRecord(record.id, {
                    status: 'delivered',
                    attempts: attempt,
                    last_attempt_at: new Date().toISOString(),
                });
                delivered++;
                logger.info('[Queue] Delivered', { id: record.id, attempt });
            } else {
                const body = await res.text().catch(() => '');
                logger.warn('[Queue] Retry failed', { id: record.id, attempt, status: res.status, body: body.substring(0, 200) });
                updateRecord(record.id, {
                    status: attempt >= MAX_ATTEMPTS ? 'failed' : 'pending',
                    attempts: attempt,
                    last_attempt_at: new Date().toISOString(),
                });
                if (attempt >= MAX_ATTEMPTS) failed++;
            }
        } catch (err) {
            logger.warn('[Queue] Retry error', { id: record.id, attempt, error: err.message });
            updateRecord(record.id, {
                status: attempt >= MAX_ATTEMPTS ? 'failed' : 'pending',
                attempts: attempt,
                last_attempt_at: new Date().toISOString(),
            });
            if (attempt >= MAX_ATTEMPTS) failed++;
        }
    }

    const remaining = getByStatus('pending').length;
    return { delivered, failed, remaining };
}

/**
 * Queue status summary.
 */
function getStatus() {
    const all = readAll();
    return {
        total: all.length,
        pending: all.filter(r => r.status === 'pending').length,
        delivered: all.filter(r => r.status === 'delivered').length,
        failed: all.filter(r => r.status === 'failed').length,
        oldest_pending: all.filter(r => r.status === 'pending')
            .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.created_at || null,
        failed_records: all.filter(r => r.status === 'failed').map(r => ({
            id: r.id,
            created_at: r.created_at,
            source: r.source,
            client_name: r.client_name,
            client_message: r.client_message?.substring(0, 100),
            attempts: r.attempts,
        })),
    };
}

module.exports = { enqueue, retryPending, getStatus, getByStatus, readAll };

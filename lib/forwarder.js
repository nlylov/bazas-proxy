// lib/forwarder.js
// Thin HTTP forwarder used by VAPI and Yelp Zapier endpoints.
// Forwards an incoming Express request to the CRM (`crm.asap.repair` by default)
// transparently, preserving status code and body so callers see no difference.
//
// Override target via env:  FORWARD_TARGET_BASE=https://app.bazas.ai
//
// To remove this proxy entirely:
//   1. Update VAPI dashboard / Zapier to point directly at the CRM URL.
//   2. Stop the Railway service `repair-asap-proxy-production`.

const { logger } = require('./utils/log');

const TARGET_BASE = (process.env.FORWARD_TARGET_BASE || 'https://crm.asap.repair').replace(/\/$/, '');

const PASSTHROUGH_HEADERS = [
    'content-type',
    'x-webhook-secret',
    'x-api-key',
    'x-vapi-signature',
    'x-vapi-secret',
    'authorization',
    'user-agent',
];

/**
 * Forward an Express request to a CRM endpoint and stream back the response.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} targetPath  CRM path starting with `/`, e.g. `/api/vapi/webhook`.
 * @param {object} [options]
 * @param {(body:any)=>any} [options.transformBody]  Optional payload transformer.
 * @param {Record<string,string>} [options.extraHeaders]
 */
async function forwardToCrm(req, res, targetPath, options = {}) {
    const { transformBody = null, extraHeaders = {} } = options;
    const queryString = req.originalUrl.includes('?')
        ? '?' + req.originalUrl.split('?').slice(1).join('?')
        : '';
    const targetUrl = `${TARGET_BASE}${targetPath}${queryString}`;

    const fwdHeaders = {
        'X-Forwarded-By': 'bazas-proxy',
        'X-Forwarded-Proto': req.protocol || 'https',
        'X-Forwarded-Host': req.get('host') || '',
    };
    for (const h of PASSTHROUGH_HEADERS) {
        const v = req.headers[h];
        if (v) fwdHeaders[h] = Array.isArray(v) ? v.join(',') : v;
    }
    Object.assign(fwdHeaders, extraHeaders);

    const fetchOpts = { method: req.method, headers: fwdHeaders, redirect: 'follow' };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
        const bodyToSend = transformBody ? transformBody(req.body) : req.body;
        fetchOpts.body = JSON.stringify(bodyToSend);
        fwdHeaders['content-type'] = 'application/json';
    }

    const startedAt = Date.now();
    try {
        const upstream = await fetch(targetUrl, fetchOpts);
        const text = await upstream.text();
        const ms = Date.now() - startedAt;
        logger.info('[Forwarder] OK', {
            method: req.method,
            from: req.originalUrl,
            to: targetUrl,
            status: upstream.status,
            ms,
        });
        res.status(upstream.status);
        res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
        res.setHeader('X-Forwarded-Target', targetUrl);
        res.setHeader('X-Forwarded-Latency-Ms', String(ms));
        return res.send(text);
    } catch (err) {
        const ms = Date.now() - startedAt;
        logger.error('[Forwarder] FAILED', {
            method: req.method,
            from: req.originalUrl,
            to: targetUrl,
            error: err.message,
            ms,
        });
        return res.status(502).json({
            error: 'Bad Gateway — forwarder could not reach CRM',
            target: targetUrl,
            message: err.message,
            note: 'bazas-proxy is in forwarder-mode. Check CRM availability or update VAPI/Zapier to point at the CRM directly.',
        });
    }
}

module.exports = { forwardToCrm, TARGET_BASE };

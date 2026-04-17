// api/vapi.js — FORWARDER MODE
//
// All VAPI logic has been migrated to bazas-crm (PR #18). This module now
// transparently forwards every VAPI request to crm.asap.repair, so the VAPI
// dashboard can keep its existing Server URL and tool URLs pointing at this
// proxy without breaking anything.
//
// To remove the proxy from the VAPI flow:
//   1. In the VAPI dashboard, change Server URL and tool URLs from
//        https://repair-asap-proxy-production.up.railway.app/api/vapi/*
//      to
//        https://app.bazas.ai/api/vapi/*           (canonical platform URL)
//      or
//        https://crm.asap.repair/api/vapi/*        (white-label vanity URL)
//   2. Make a test call and verify Railway logs at bazas-crm.
//   3. Stop the Railway service `repair-asap-proxy-production`.
//
// The legacy implementation is preserved in api/vapi.legacy.js for emergency
// rollback (delete this comment block and `require('./vapi.legacy')` instead).

const express = require('express');
const { forwardToCrm, TARGET_BASE } = require('../lib/forwarder');
const { logger } = require('../lib/utils/log');

const router = express.Router();

const FORWARDED_ROUTES = ['/webhook', '/calendar', '/book', '/outbound', '/transfer'];

FORWARDED_ROUTES.forEach((path) => {
    router.post(path, (req, res) => forwardToCrm(req, res, `/api/vapi${path}`));
});

router.get('/health', (_req, res) => res.json({
    forwarder: true,
    target: TARGET_BASE,
    routes: FORWARDED_ROUTES.map(p => `POST /api/vapi${p}`),
    note: 'VAPI is handled by bazas-crm. This proxy forwards requests for backwards compatibility.',
}));

logger.info('[VAPI] forwarder-mode active', { target: TARGET_BASE, routes: FORWARDED_ROUTES });

module.exports = router;

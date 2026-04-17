# bazas-proxy — FORWARDER MODE

> **Status: Decommissioning.** All business logic has been migrated to **bazas-crm**.
> This service is kept alive only as a thin **forwarder** so that VAPI dashboard and Zapier
> webhooks (which point at `repair-asap-proxy-production.up.railway.app/...`) keep working
> without manual reconfiguration.

## What is forwarded

| Incoming on this proxy | Forwarded to |
|------------------------|--------------|
| `POST /api/vapi/webhook`   | `crm.asap.repair/api/vapi/webhook`   |
| `POST /api/vapi/calendar`  | `crm.asap.repair/api/vapi/calendar`  |
| `POST /api/vapi/book`      | `crm.asap.repair/api/vapi/book`      |
| `POST /api/vapi/outbound`  | `crm.asap.repair/api/vapi/outbound`  |
| `POST /api/vapi/transfer`  | `crm.asap.repair/api/vapi/transfer`  |
| `POST /api/yelp-zapier`    | `crm.asap.repair/api/webhooks/yelp` (with payload field-name transform) |
| `POST /api/webhooks/thumbtack` | `crm.asap.repair/api/webhooks/thumbtack` |
| `GET  /api/webhooks/thumbtack` | `crm.asap.repair/api/webhooks/thumbtack` |

The forwarder target can be overridden with the env var `FORWARD_TARGET_BASE`
(e.g. `https://app.bazas.ai` for the canonical platform URL).

## What still runs locally on this proxy (NOT forwarded)

These endpoints continue to use the proxy's own legacy logic so that nothing breaks
for any leftover caller (cached browser tabs, GHL workflows, etc.). They will be
removed once every caller has been migrated to the CRM.

- `POST /api/thread`, `POST /api/message`, `POST /api/chat-photo` — old chat widget
  (new widget on asap.repair already calls `crm.asap.repair/api/widget/*` directly).
- `POST /api/quote`, `GET /api/calendar-slots`, `GET /api/check-customer` — same as above.
- `POST /api/ai-hub/webhook`, `POST /api/ai-hub/test` — used by GHL workflows.
- `POST /api/queue-status`, `POST /api/queue-retry` — internal queue management.
- `GET /api/health` — Railway healthcheck.

## How to fully retire this proxy

1. **VAPI dashboard** → Org Settings → change Server URL and tool URLs from
   `https://repair-asap-proxy-production.up.railway.app/api/vapi/*`
   to `https://app.bazas.ai/api/vapi/*` (canonical) or
   `https://crm.asap.repair/api/vapi/*` (white-label vanity).
2. **Zapier** → Yelp "New Consumer Message" zap → change webhook URL from
   `https://repair-asap-proxy-production.up.railway.app/api/yelp-zapier`
   to `https://app.bazas.ai/api/webhooks/yelp` and add header
   `X-Webhook-Secret: <NEW_CRM_WEBHOOK_SECRET>`.
3. Make a live test (chat widget, quote form, VAPI call, Yelp lead).
4. **Railway** → `repair-asap-proxy-production` → Stop service.
5. Keep the GitHub repo as an archive (do not delete).

## Required env vars (for forwarder mode)

- `FORWARD_TARGET_BASE` — optional, defaults to `https://crm.asap.repair`
- `NEW_CRM_WEBHOOK_SECRET` — required for `/api/yelp-zapier` forwarding
- `WEBHOOK_SECRET` — alternative name for the same secret (used by VAPI tool calls)
- `CRM_BASE_URL`, `CRM_API_KEY`, `OPENAI_API_KEY`, `OPENAI_ASSISTANT_ID`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_*_CHAT_ID` — still used by the non-forwarded routes.

## Rollback

If forwarder mode misbehaves and you need the legacy in-process VAPI logic back:

```bash
git revert <this commit>
```

The legacy VAPI implementation is also preserved as `api/vapi.legacy.js` for reference.

## Dev

```bash
npm install
node server.js
```

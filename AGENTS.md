# AGENTS — STOP. READ THIS BEFORE TOUCHING ANYTHING.

> **This repository is in DECOMMISSION mode. DO NOT add features. DO NOT debug
> business logic here. ALL business logic lives in `bazas-crm`.**

## What this service is

A **dumb HTTP forwarder** that exists for one reason only: a few external
vendor dashboards (VAPI, Zapier, Thumbtack) have hard-coded webhook URLs
pointing at this Railway service that we cannot change instantly. Each
forwarded route just proxies the request to the corresponding endpoint on
`crm.asap.repair` and streams the response back.

There is **NO** business logic here. There is **NO** AI here. There is **NO**
data persistence here. If a feature needs to be added, fixed, or changed —
**always do it in `bazas-crm`**, never here.

## Where the real code lives

| What you might be looking for | Where it actually lives |
|-------------------------------|--------------------------|
| VAPI webhook / tool-call logic | `bazas-crm/app/api/vapi/*` |
| Yelp lead processing, AI auto-reply | `bazas-crm/app/api/webhooks/yelp/route.ts` |
| Thumbtack ingestion | `bazas-crm/app/api/webhooks/thumbtack/route.ts` |
| Website quote / contact form | `bazas-crm/app/api/widget/*` |
| Calendar slot lookup | `bazas-crm/app/api/calendar/slots/route.ts` |
| Knowledge base / pricing rules | `bazas-crm/lib/knowledge-base*` and CRM Settings UI |
| Twilio voice / SMS | `bazas-crm/app/api/twilio/*` |
| Telegram notifications | `bazas-crm/lib/telegram-notify.ts` |

## What you are allowed to touch in THIS repo

Almost nothing. The only legitimate edits are:

1. **Adding a new forwarder route** when a new vendor webhook is added —
   import `forwardToCrm` from `lib/forwarder.js` and add a one-liner.
2. **Bumping `FORWARD_TARGET_BASE`** environment variable on Railway if the
   CRM moves to a different hostname.
3. **Removing forwarders** when the corresponding vendor URL has been migrated
   off this proxy (see `MIGRATION-PATH.md`).

Anything else — auth, AI prompts, knowledge base, contact persistence,
calendar, Twilio, dashboards — **MUST go in `bazas-crm`**.

## How to know if something is a forwarder bug or a CRM bug

Smoke test:

```bash
# Hit the same path on both proxy and CRM. If they return different things,
# it's a forwarder bug. If they return the same thing and it's wrong, it's
# a CRM bug. 99% of the time it's a CRM bug.
curl -X POST https://repair-asap-proxy-production.up.railway.app/api/vapi/webhook ...
curl -X POST https://crm.asap.repair/api/vapi/webhook ...
```

If you find yourself reading anything in `api/index.js` other than the
forwarder routes (lines mentioning `forwardToCrm` or `/api/yelp-zapier`),
**you are in the wrong repository**. Close this and open `bazas-crm`.

## Plan to delete this service entirely

See `MIGRATION-PATH.md` for the click-by-click checklist. tl;dr:

1. Update VAPI dashboard Server URL + tool URLs to `crm.asap.repair`.
2. Update Zapier Yelp webhook URL to `crm.asap.repair/api/yelp-zapier`.
3. Confirm Thumbtack URL (probably already on `asap.repair` and handled by a
   Cloudflare Pages Function).
4. Stop the Railway service `repair-asap-proxy-production`.
5. Archive (do NOT delete) this GitHub repo.

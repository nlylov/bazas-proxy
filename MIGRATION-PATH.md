# How to delete this proxy entirely

This service exists ONLY because three vendor dashboards (VAPI, Zapier,
Thumbtack) have webhook URLs pointing at `repair-asap-proxy-production.up.railway.app`
that we cannot change without logging into those dashboards.

Once those URLs are repointed at the CRM, this service can be stopped and the
repository archived. There is **no business logic** here that needs to be
ported — everything already lives in `bazas-crm`.

## Step-by-step shutdown

### 1. VAPI Dashboard (~5 min)

Go to https://dashboard.vapi.ai → your org.

**Server URL** (Org Settings → Server URL):
- FROM: `https://repair-asap-proxy-production.up.railway.app/api/vapi/webhook`
- TO:   `https://crm.asap.repair/api/vapi/webhook`

**Custom tools** (Tools → each tool → URL field):

| Tool name | Old URL | New URL |
|-----------|---------|---------|
| `checkAvailability` | `…repair-asap-proxy…/api/vapi/calendar` | `https://crm.asap.repair/api/vapi/calendar` |
| `bookAppointment`   | `…repair-asap-proxy…/api/vapi/book`     | `https://crm.asap.repair/api/vapi/book`     |
| `transferToHuman`   | `…repair-asap-proxy…/api/vapi/transfer` | `https://crm.asap.repair/api/vapi/transfer` |

**Test:** make a real call to the Anna number. Ask for an appointment
tomorrow → she should find slots and book one. Verify a new appointment
appears in `crm.asap.repair/calendar`.

### 2. Zapier (~2 min)

Open the Yelp "New Consumer Message" zap → the `Webhook by Zapier` step → Edit.

- **URL FROM:** `https://repair-asap-proxy-production.up.railway.app/api/yelp-zapier`
- **URL TO:**   `https://crm.asap.repair/api/yelp-zapier`

(No header configuration needed — the new alias accepts the same payload
shape as the legacy proxy.)

**Test:** trigger a Zapier test run with the existing test data. Confirm
the response is `{success: true, ...}` and a new lead appears in CRM.

### 3. Thumbtack (~1 min — usually no change needed)

Check your Thumbtack Pro account → Settings → API Integration → Webhook URL.

| If it points at | Do this |
|-----------------|---------|
| `https://asap.repair/api/webhooks/thumbtack` | Nothing — already handled by a Cloudflare Pages Function. |
| `https://crm.asap.repair/api/webhooks/thumbtack` | Nothing — already CRM-direct. |
| `https://repair-asap-proxy-production.up.railway.app/api/webhooks/thumbtack` | Update to `https://crm.asap.repair/api/webhooks/thumbtack`. (Note: Thumbtack often requires a support ticket to change webhook URLs after API approval.) |
| Anything else | Tell us the URL — we'll add a forwarder there. |

### 4. Stop the Railway service

Railway dashboard → project → `repair-asap-proxy-production` service → Settings → "Remove Service" or "Stop".

**Do NOT delete the GitHub repo** — keep it as an archive of the original implementation.

### 5. Smoke test after shutdown

```bash
# These should now FAIL with connection refused / 502 — that's expected:
curl -m 5 https://repair-asap-proxy-production.up.railway.app/api/health
curl -m 5 -X POST https://repair-asap-proxy-production.up.railway.app/api/vapi/webhook -d '{}'

# These should still WORK (the actual integrations):
curl -m 10 -X POST https://crm.asap.repair/api/vapi/webhook -H 'content-type: application/json' -d '{"message":{"type":"test"}}'
curl -m 10 -X POST https://crm.asap.repair/api/yelp-zapier -H 'content-type: application/json' -d '{"consumer_name":"smoke","category":"test"}'
curl -m 10 -X POST https://asap.repair/api/webhooks/thumbtack -d '{}'
```

If anything in the second group fails — the CRM has a problem, not the
shutdown. Re-check the corresponding route in `bazas-crm`.

## What stays alive after shutdown

- **bazas-crm** (Railway) — the actual application
- **asap.repair** (Cloudflare Pages) — static site + 1 forwarder function for Thumbtack
- **GHL workflows** (if any still firing into proxy `/api/ai-hub/webhook`) — these need separate migration. As of last review, GHL is being phased out.

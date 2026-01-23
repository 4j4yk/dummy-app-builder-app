# Magento/AdobeCommerce/any other fork of the same → Node (App Builder-like) → Dummy Target (Minimal Data-Flow POC)

This project proves a simple data flow:
**Magento/AdobeCommerce/any other fork of the same (source orders) → Node action runner → Target system**.

It intentionally skips:
- message transformation
- retries/idempotency
- persistence/queues
- complex error handling

The code mimics an App Builder "action" shape (`actions/forward-order.js` exporting `main(params)`),
but runs locally without Adobe App Builder licenses. (yea I was hit by that wall)

## Prerequisites
- macOS (latest)
- Node.js **20+** (recommended via Homebrew, what i use usually)

### Install Node.js 20+ (Homebrew)
```bash
brew update
brew install node
node -v
```
Ensure the version is >= 20.

## Setup
1. Unzip this project and open a terminal in the project folder.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create your `.env`:
   ```bash
   cp .env.example .env
   ```
4. Edit `.env` and set:
   - `COMMERCE_BASE_URL` (example: `https://your-domain/rest/default/V1`)
   - `COMMERCE_ACCESS_TOKEN` (integration token preferred)

## Run
```bash
npm start
```

You should see:
- server running on `http://localhost:3000`
- auto-poll info (if enabled)

## Verify
1. Health check:
   ```bash
   curl http://localhost:3000/health
   ```

2. Manually trigger one poll cycle:
   ```bash
   curl -X POST http://localhost:3000/run/poll-once
   ```

3. Place a new order in commerce, then run `/run/poll-once` again.
   You should see logs like:
   - `[WAREHOUSE] Ingested order: <increment_id>` (pipeline mode)
   - `[POLL] attempted forwards: <n>`

## Pipeline MVP
This adds an enrichment step (region, riskScore, processedAt) and sends a slimmed payload to a local
warehouse-like endpoint that appends JSON lines to `data/warehouse.jsonl`.

Enriched payload fields:
- `entity_id`, `increment_id`, `created_at`, `status`, `grand_total`, `customer_email`, `region`, `riskScore`, `processedAt`

### Env vars
Add to `.env` (defaults shown):
- `PIPELINE_MODE=true`
- `WAREHOUSE_URL=http://localhost:3000/warehouse/ingest`

### Run + test
```bash
npm install
cp .env.example .env
npm start
curl -X POST http://localhost:3000/run/poll-once
curl http://localhost:3000/admin/sent
curl http://localhost:3000/admin/warehouse?limit=5
tail -n 5 data/warehouse.jsonl
```

Notes:
- `POST /target/orders` is the only target endpoint; `GET /target/orders` returns a short instruction payload.
- For a demo without creating a Commerce order manually, use: `curl -X POST http://localhost:3000/run/demo-order`
- `/run/poll-once` returns a non-200 if any order failed to forward or ingest.

## Notes on COMMERCE_BASE_URL
Recommended form:
- `https://<domain>/rest/<store_code>/V1`
Examples:
- `https://example.com/rest/default/V1`
- `https://example.com/rest/default/V1`

If your site uses a different REST base path, adjust `COMMERCE_BASE_URL` accordingly.

## Swap to a real target later
Replace in `.env`:
- `TARGET_URL=https://real-target.example.com/api/orders`

The action will forward the order to that endpoint.
code may need more updates for target endpoints.

## Persistence of forwarded orders (minimal)
This version persists forwarded `entity_id`s to:
- `data/sent.json`

This prevents re-sending the same recent orders across restarts.

Useful admin endpoints:
- `GET /admin/sent` — view persisted sent IDs
- `POST /admin/sent/reset` — clear sent IDs (handy for demos)
- `GET /admin/warehouse?limit=20` — view the most recent ingested records

## Demo gif
![demo](/demo.gif)

## Testing
No automated tests are configured yet; validation is manual via the endpoints above.

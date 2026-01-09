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
   - `[TARGET] Received order: <increment_id>`
   - `[POLL] attempted forwards: <n>`

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

## Demo gif
![demo](/demo.gif)

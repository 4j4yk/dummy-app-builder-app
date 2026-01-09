import express from "express";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRecentOrders, fetchOrderById } from "./mageos.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const COMMERCE_BASE_URL = process.env.COMMERCE_BASE_URL;
const COMMERCE_ACCESS_TOKEN = process.env.COMMERCE_ACCESS_TOKEN;
const TARGET_URL = process.env.TARGET_URL || `http://localhost:${PORT}/target/orders`;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);

// Persisted "sent" tracking so restarts don't resend.
const SENT_FILE = path.resolve(__dirname, "../data/sent.json");

function loadSentIds() {
  try {
    const raw = fs.readFileSync(SENT_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed.sent_order_ids) ? parsed.sent_order_ids : [];
    return new Set(ids.map(String));
  } catch {
    // If file missing/corrupt, start fresh (minimal behavior)
    return new Set();
  }
}

function saveSentIds(set) {
  const ids = Array.from(set.values());
  const payload = { sent_order_ids: ids };
  fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true });
  fs.writeFileSync(SENT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

const sentOrderIds = loadSentIds();

function requireEnv() {
  if (!COMMERCE_BASE_URL) throw new Error("Missing COMMERCE_BASE_URL in .env");
  if (!COMMERCE_ACCESS_TOKEN) throw new Error("Missing COMMERCE_ACCESS_TOKEN in .env");
}

async function invokeAction(actionPath, params) {
  const mod = await import(actionPath);
  if (!mod?.main) throw new Error(`Action at ${actionPath} does not export 'main'`);
  return await mod.main(params);
}

async function pollOnce() {
  requireEnv();
  const orders = await fetchRecentOrders({
    baseUrl: COMMERCE_BASE_URL,
    token: COMMERCE_ACCESS_TOKEN,
    pageSize: 10
  });

  const results = [];
  for (const order of orders) {
    const id = String(order.entity_id);
    if (sentOrderIds.has(id)) continue;

    const out = await invokeAction(new URL("../actions/forward-order.js", import.meta.url).href, {
      order,
      TARGET_URL
    });

    // If forwarding succeeded, mark as sent (minimal)
    if (out?.statusCode === 200) {
      sentOrderIds.add(id);
      saveSentIds(sentOrderIds);
    }

    results.push(out?.body || out);
  }
  return results;
}

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, sent_count: sentOrderIds.size, target_url: TARGET_URL, sent_file: SENT_FILE });
});

// Inspect sent IDs (for debugging/demo)
app.get("/admin/sent", (_req, res) => {
  res.json({ ok: true, sent_order_ids: Array.from(sentOrderIds.values()) });
});

// Reset sent IDs (useful for demos)
app.post("/admin/sent/reset", (_req, res) => {
  sentOrderIds.clear();
  saveSentIds(sentOrderIds);
  res.json({ ok: true, message: "sent_order_ids cleared" });
});

// Dummy target system endpoint (replace TARGET_URL to point to real system later)
app.post("/target/orders", (req, res) => {
  const body = req.body || {};
  console.log("[TARGET] Received order:", body.increment_id || body.order_id);
  res.json({
    ok: true,
    ref: `TGT-${Date.now()}`,
    received: { order_id: body.order_id, increment_id: body.increment_id }
  });
});

// Manual trigger to run one poll cycle
app.post("/run/poll-once", async (_req, res) => {
  try {
    const results = await pollOnce();
    res.json({ ok: true, forwarded_attempts: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Optional manual forward by order entity_id
app.post("/run/forward/:orderId", async (req, res) => {
  try {
    requireEnv();
    const orderId = req.params.orderId;
    const order = await fetchOrderById({ baseUrl: COMMERCE_BASE_URL, token: COMMERCE_ACCESS_TOKEN, orderId });

    const out = await invokeAction(new URL("../actions/forward-order.js", import.meta.url).href, {
      order,
      TARGET_URL
    });

    if (out?.statusCode === 200) {
      sentOrderIds.add(String(order.entity_id));
      saveSentIds(sentOrderIds);
    }

    res.status(out.statusCode || 200).json(out.body || out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`POC runner listening on http://localhost:${PORT}`);
  console.log(`Health: GET http://localhost:${PORT}/health`);
  console.log(`Manual poll: POST http://localhost:${PORT}/run/poll-once`);
  console.log(`Dummy target: POST http://localhost:${PORT}/target/orders`);
  console.log(`Sent IDs: GET http://localhost:${PORT}/admin/sent`);
  console.log(`Reset sent: POST http://localhost:${PORT}/admin/sent/reset`);
  console.log(`Sent file: ${SENT_FILE}`);
  if (POLL_INTERVAL_MS > 0) {
    console.log(`Auto-poll enabled: every ${POLL_INTERVAL_MS} ms`);
    setInterval(async () => {
      try {
        const results = await pollOnce();
        if (results.length) console.log(`[POLL] attempted forwards: ${results.length}`);
      } catch (e) {
        console.error("[POLL] error:", e.message);
      }
    }, POLL_INTERVAL_MS);
  } else {
    console.log("Auto-poll disabled (POLL_INTERVAL_MS=0). Use /run/poll-once manually.");
  }
});

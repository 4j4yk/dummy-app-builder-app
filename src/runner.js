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
const WAREHOUSE_URL = process.env.WAREHOUSE_URL || `http://localhost:${PORT}/warehouse/ingest`;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const PIPELINE_MODE = parseBoolean(process.env.PIPELINE_MODE ?? "true");

// Persisted "sent" tracking so restarts don't resend.
const SENT_FILE = path.resolve(__dirname, "../data/sent.json");
const WAREHOUSE_FILE = path.resolve(__dirname, "../data/warehouse.jsonl");

function parseBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return Boolean(value);
}

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

async function postJson(url, payload, label) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    throw new Error(`${label} unreachable: ${e.message}`);
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    // ignore non-JSON
  }

  if (!res.ok) {
    throw new Error(`${label} error: ${res.status}`);
  }

  return { statusCode: 200, body: data };
}

async function handlePipeline(order) {
  const actionOut = await invokeAction(new URL("../actions/pipeline-order.js", import.meta.url).href, {
    order,
    config: { TARGET_URL, WAREHOUSE_URL, PIPELINE_MODE }
  });

  if (actionOut?.statusCode && actionOut.statusCode !== 200) {
    const errorMessage = actionOut?.body?.error || "Pipeline action failed";
    throw new Error(errorMessage);
  }

  const enriched = actionOut?.body?.enriched || actionOut?.enriched;
  if (!enriched) {
    throw new Error("Pipeline action did not return enriched payload");
  }

  await postJson(WAREHOUSE_URL, enriched, "Warehouse");

  return {
    statusCode: 200,
    body: {
      ok: true,
      pipeline: true,
      forwarded: {
        order_id: enriched.entity_id,
        increment_id: enriched.increment_id
      }
    }
  };
}

async function handleForward(order) {
  return await invokeAction(new URL("../actions/forward-order.js", import.meta.url).href, {
    order,
    TARGET_URL
  });
}

function buildDemoOrder(overrides = {}) {
  const now = new Date();
  const id = overrides.entity_id ?? Date.now();
  const incrementId =
    overrides.increment_id ??
    `${String(id).slice(-6).padStart(6, "0")}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;

  return {
    entity_id: id,
    increment_id: incrementId,
    status: "pending",
    grand_total: 99.0,
    customer_email: "demo.buyer@example.com",
    created_at: now.toISOString(),
    shipping_address: {
      region: "California",
      region_code: "CA"
    },
    ...overrides
  };
}

async function pollOnce() {
  requireEnv();
  const orders = await fetchRecentOrders({
    baseUrl: COMMERCE_BASE_URL,
    token: COMMERCE_ACCESS_TOKEN,
    pageSize: 10
  });

  const results = [];
  let hadError = false;
  for (const order of orders) {
    const id = String(order.entity_id);
    if (sentOrderIds.has(id)) continue;

    let out;
    try {
      out = PIPELINE_MODE ? await handlePipeline(order) : await handleForward(order);
    } catch (e) {
      hadError = true;
      console.error("[POLL] error:", e.message);
      results.push({
        ok: false,
        error: e.message,
        order_id: order.entity_id,
        increment_id: order.increment_id
      });
      continue;
    }

    const body = out?.body || out;

    // If forwarding succeeded, mark as sent (minimal)
    if (out?.statusCode === 200) {
      sentOrderIds.add(id);
      saveSentIds(sentOrderIds);
    } else {
      hadError = true;
    }

    results.push({
      ...(body || {}),
      order_id: order.entity_id,
      increment_id: order.increment_id
    });
  }
  return { results, hadError };
}

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    sent_count: sentOrderIds.size,
    pipeline_mode: PIPELINE_MODE,
    target_url: TARGET_URL,
    warehouse_url: WAREHOUSE_URL,
    sent_file: SENT_FILE
  });
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

app.get("/target/orders", (_req, res) => {
  res.json({
    ok: true,
    message: "POST orders to this endpoint. GET is for info only.",
    example: { method: "POST", path: "/target/orders" }
  });
});

app.post("/warehouse/ingest", (req, res) => {
  try {
    const body = req.body || {};
    const id = body.increment_id || body.entity_id || body.order_id || "unknown";

    fs.mkdirSync(path.dirname(WAREHOUSE_FILE), { recursive: true });
    fs.appendFileSync(WAREHOUSE_FILE, JSON.stringify(body) + "\n", "utf-8");

    console.log(`[WAREHOUSE] Ingested order: ${id}`);
    res.json({ status: "ok" });
  } catch (e) {
    console.error("[WAREHOUSE] error:", e.message);
    res.status(500).json({ status: "error", error: "Warehouse ingest failed" });
  }
});

app.get("/admin/warehouse", (req, res) => {
  const limitRaw = Number(req.query.limit || 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 20;

  try {
    const raw = fs.readFileSync(WAREHOUSE_FILE, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const slice = lines.slice(-limit);
    const records = slice.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });

    res.json({ ok: true, count: records.length, records });
  } catch (e) {
    if (e.code === "ENOENT") {
      return res.json({ ok: true, count: 0, records: [] });
    }
    console.error("[WAREHOUSE] read error:", e.message);
    res.status(500).json({ ok: false, error: "Warehouse read failed" });
  }
});

// Manual trigger to run one poll cycle
app.post("/run/poll-once", async (_req, res) => {
  try {
    const { results, hadError } = await pollOnce();
    if (hadError) {
      return res.status(500).json({ ok: false, forwarded_attempts: results.length, results });
    }
    res.json({ ok: true, forwarded_attempts: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Demo trigger: create a synthetic order and run pipeline/forward directly
app.post("/run/demo-order", async (req, res) => {
  try {
    const overrides = req.body?.order && typeof req.body.order === "object" ? req.body.order : {};
    const order = buildDemoOrder(overrides);
    const out = PIPELINE_MODE ? await handlePipeline(order) : await handleForward(order);

    if (out?.statusCode === 200) {
      sentOrderIds.add(String(order.entity_id));
      saveSentIds(sentOrderIds);
    }

    res.status(out.statusCode || 200).json({
      ok: out?.body?.ok ?? true,
      demo: true,
      order_id: order.entity_id,
      increment_id: order.increment_id,
      result: out?.body || out
    });
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

    const out = PIPELINE_MODE ? await handlePipeline(order) : await handleForward(order);

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
        const { results, hadError } = await pollOnce();
        if (results.length) console.log(`[POLL] attempted forwards: ${results.length}`);
        if (hadError) console.error("[POLL] completed with errors");
      } catch (e) {
        console.error("[POLL] error:", e.message);
      }
    }, POLL_INTERVAL_MS);
  } else {
    console.log("Auto-poll disabled (POLL_INTERVAL_MS=0). Use /run/poll-once manually.");
  }
});

/**
 * Minimal "App Builder-like" action:
 * - Signature: main(params)
 * - Returns: { statusCode, headers?, body }
 *
 * This action forwards a Mage-OS order payload to a target endpoint.
 * Intentionally minimal: no transformation, retries, idempotency, or persistence.
 */

export async function main(params = {}) {
  const order = params.order;
  const targetUrl = params.TARGET_URL;

  if (!order || typeof order !== "object") {
    return { statusCode: 400, body: { ok: false, error: "Missing params.order" } };
  }
  if (!targetUrl) {
    return { statusCode: 400, body: { ok: false, error: "Missing TARGET_URL" } };
  }

  // Minimal payload: include a few common fields + raw
  const payload = {
    source: "mageos",
    order_id: order.entity_id,
    increment_id: order.increment_id,
    status: order.status,
    grand_total: order.grand_total,
    customer_email: order.customer_email,
    created_at: order.created_at,
    raw: order
  };

  let res;
  try {
    res = await fetch(targetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return { statusCode: 502, body: { ok: false, error: `Target unreachable: ${e.message}` } };
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    // ignore
  }

  return {
    statusCode: res.ok ? 200 : 502,
    body: {
      ok: res.ok,
      forwarded: { order_id: payload.order_id, increment_id: payload.increment_id },
      target_status: res.status,
      target_response: data
    }
  };
}

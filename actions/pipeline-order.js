/**
 * Minimal "App Builder-like" action:
 * - Signature: main(params)
 * - Returns: { status: "ok", enriched }
 *
 * This action enriches a Mage-OS order with region, riskScore, processedAt.
 */

function hashToScore(value) {
  const str = String(value ?? "");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % 100000;
  }
  return hash % 101;
}

function getRegion(order) {
  const direct = order?.shipping_address || {};
  if (direct.region || direct.region_code) return direct.region || direct.region_code;

  const assignment =
    order?.extension_attributes?.shipping_assignments?.[0]?.shipping?.address || {};
  if (assignment.region || assignment.region_code) {
    return assignment.region || assignment.region_code;
  }

  const billing = order?.billing_address || {};
  if (billing.region || billing.region_code) return billing.region || billing.region_code;

  return "unknown";
}

export async function main(params = {}) {
  const order = params.order;

  if (!order || typeof order !== "object") {
    return { statusCode: 400, body: { status: "error", error: "Missing params.order" } };
  }

  const region = getRegion(order);
  const riskScore = hashToScore(order.increment_id ?? order.entity_id);
  const processedAt = new Date().toISOString();

  const enriched = {
    entity_id: order.entity_id,
    increment_id: order.increment_id,
    created_at: order.created_at,
    status: order.status,
    grand_total: order.grand_total,
    customer_email: order.customer_email,
    region,
    riskScore,
    processedAt
  };

  return { statusCode: 200, body: { status: "ok", enriched } };
}

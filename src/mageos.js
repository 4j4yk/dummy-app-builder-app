/**
 * Minimal Commerce client.
 * Assumes COMMERCE_BASE_URL is in the form:
 *   https://<domain>/rest/<store_code>/V1
 * Example:
 *   https://example.local/rest/default/V1
 */

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) throw new Error("COMMERCE_BASE_URL is required");
  // Remove trailing slashes
  return baseUrl.replace(/\/+$/, "");
}

export async function fetchRecentOrders({ baseUrl, token, pageSize = 10 }) {
  const normalized = normalizeBaseUrl(baseUrl);

  // Endpoint: {base}/orders
  const url = new URL(normalized + "/orders");
  url.searchParams.set("searchCriteria[currentPage]", "1");
  url.searchParams.set("searchCriteria[pageSize]", String(pageSize));
  url.searchParams.set("searchCriteria[sortOrders][0][field]", "entity_id");
  url.searchParams.set("searchCriteria[sortOrders][0][direction]", "DESC");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Commerce fetch failed (${res.status}): ${txt || res.statusText}`);
  }

  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchOrderById({ baseUrl, token, orderId }) {
  const normalized = normalizeBaseUrl(baseUrl);
  const url = new URL(normalized + "/orders/" + encodeURIComponent(orderId));

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Commerce fetch failed (${res.status}): ${txt || res.statusText}`);
  }

  return await res.json();
}

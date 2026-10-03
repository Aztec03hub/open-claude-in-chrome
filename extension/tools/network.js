// Network request records: failed loads, as the official extension marks them
// (Network.loadingFailed -> status 503) plus the reason, and the one-line format
// read_network_requests prints.

export const FAILED_STATUS = 503;

/** Record fields for a Network.loadingFailed event; `existing` is the prior record or null. */
export function failedRecord(params, existing) {
  return {
    url: (existing && existing.url) || "(unknown url)",
    method: (existing && existing.method) || "GET",
    type: (existing && existing.type) || params.type || "Other",
    status: FAILED_STATUS,
    failed: true,
    errorText: params.errorText || (params.canceled ? "canceled" : "failed"),
    timestamp: (existing && existing.timestamp) || Date.now(),
  };
}

export function formatNetworkLine(r) {
  const status = r.failed ? `→ ${r.status} (FAILED: ${r.errorText})` : r.status ? `→ ${r.status}` : "(pending)";
  return `${r.method} ${r.url} ${status}${r.mimeType ? ` [${r.mimeType}]` : ""}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** True when a main-frame navigation moved to a different domain (official: logs are per current domain). */
export function isCrossDomain(prevUrl, nextUrl) {
  const a = hostOf(prevUrl);
  const b = hostOf(nextUrl);
  return !!a && !!b && a !== b;
}

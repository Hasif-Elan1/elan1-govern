/** Webhook events, as the gate service sends them, with plain-English labels for Settings. */
export const WEBHOOK_EVENTS = ["receipt.created", "approval.pending", "approval.resolved", "alert.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, { label: string; hint: string }> = {
  "receipt.created": { label: "Every receipt", hint: "Each decision, approval, outcome and setup change. Good for a SIEM or log store." },
  "approval.pending": { label: "Action waiting for approval", hint: "An action that needs a person." },
  "approval.resolved": { label: "Approval decided", hint: "Approved, rejected or expired." },
  "alert.created": { label: "Unusual behaviour alert", hint: "An agent did something unusual for it: a spike, a new vendor, an odd hour." },
};

export const DELIVERY_LABELS: Record<string, string> = {
  pending: "Retrying",
  delivered: "Delivered",
  failed: "Failed",
};

/** Host and path of a webhook URL for display, without the query string (it can carry tokens). */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

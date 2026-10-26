const ERRORS: Record<string, string> = {
  link_expired: "The sign-in took too long or the link was changed. Try connecting again.",
  denied: "Access was not granted, so nothing was connected.",
  not_configured: "This server has no OAuth client for that service yet.",
  no_zoho_org: "That Zoho account has no Books organisation.",
  exchange_failed: "The provider did not accept the sign-in. Try again.",
};

/** The message after returning from Google or Zoho sign-in. */
export function OAuthResult({ connected, error }: { connected?: string; error?: string }) {
  if (connected === "gmail" || connected === "zoho") {
    return <p className="mb-5 rounded-lg border border-ok-line bg-ok-soft px-4 py-3 text-sm">{connected === "gmail" ? "Gmail" : "Zoho Books"} is connected.</p>;
  }
  if (error) {
    return <p className="mb-5 rounded-lg border border-no-line bg-no-soft px-4 py-3 text-sm">{ERRORS[error] ?? "Connecting did not work. Try again."}</p>;
  }
  return null;
}

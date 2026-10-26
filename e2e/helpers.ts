import { randomBytes } from "node:crypto";
import { request as pwRequest, expect, type APIRequestContext, type Page } from "@playwright/test";

export const WEB = process.env.WEB_URL ?? "http://localhost:3000";
export const PASSWORD = "quiet monsoon ledger 7";

/** AI risk triage answers for a customer chatbot: score 7, medium risk. */
export const TRIAGE_MEDIUM = { autonomy: "informs", areas: ["none"], external: "yes", affected: ["customers"], data: ["personal"], oversight: "sampled", appeal: "yes", supplier: "documented" };

export const uniqueEmail = (p = "user") => `${p}-${randomBytes(4).toString("hex")}@e2e.test`;

/** A signed-in API client: cookies kept, CSRF token and Origin sent on every write. */
export class Client {
  constructor(readonly ctx: APIRequestContext, readonly email: string) {}

  static async anonymous() {
    const ctx = await pwRequest.newContext({ baseURL: WEB });
    await ctx.get("/login");
    return new Client(ctx, "");
  }

  async csrf() {
    const state = await this.ctx.storageState();
    return state.cookies.find((c) => c.name === "gate_csrf")?.value ?? "";
  }

  async send(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.ctx.fetch(path, {
      method,
      headers: { "content-type": "application/json", origin: WEB, "x-csrf-token": await this.csrf(), ...headers },
      ...(body !== undefined ? { data: JSON.stringify(body) } : {}),
    });
  }

  get(path: string) {
    return this.ctx.get(path, { maxRedirects: 0 });
  }

  static async signUp(prefix = "user", invite?: { token: string; email: string }) {
    const c = await Client.anonymous();
    const email = invite?.email ?? uniqueEmail(prefix);
    const res = await c.send("POST", "/api/auth/signup", { name: `${prefix[0]!.toUpperCase()}${prefix.slice(1)} Tester`, email, password: PASSWORD, ...(invite ? { invite: invite.token } : {}) });
    expect(res.status(), await res.text()).toBe(200);
    return new Client(c.ctx, email);
  }

  /** A new user who owns a new org. */
  static async owner(orgName = "E2E Traders Pvt Ltd") {
    const c = await Client.signUp("owner");
    const r = await c.send("POST", "/api/orgs", { name: orgName });
    expect(r.status(), await r.text()).toBe(200);
    return c;
  }

  /** Invite someone with a role and return their signed-in client. */
  async invite(role: string) {
    const email = uniqueEmail(role);
    const r = await this.send("POST", "/api/members", { email, role });
    expect(r.status(), await r.text()).toBe(200);
    const link = (await r.json()).link as string;
    return Client.signUp(role, { token: link.split("/invite/")[1]!, email });
  }
}

export async function signInUI(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** The newest approval link emailed to someone (via Mailpit's API). */
export async function approvalLinkFor(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=5`);
    if (res.ok) {
      const data = (await res.json()) as { messages: { ID: string }[] };
      for (const m of data.messages ?? []) {
        const msg = (await (await fetch(`http://localhost:8025/api/v1/message/${m.ID}`)).json()) as { Text: string };
        const link = /(https?:\/\/\S+\/approve\/\S+)/.exec(msg.Text)?.[1];
        if (link) return link;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no approval email for ${email}`);
}

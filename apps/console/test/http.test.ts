import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookie, csrfToken, del, get, HttpError, NetworkError, post, setCsrfToken, setHttpHooks, setTransport } from "../src/api/http";

// The console's HTTP client against a fake fetch: what it sends (same origin, credentials, CSRF) and how it reads
// the server's answers (errors, rate limits, re-authentication, a session the server ended, no connection).

interface Sent { url: string; init: RequestInit }
let sent: Sent[] = [];
let answers: (() => Response | Promise<Response>)[] = [];
let jar = "";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  sent = [];
  answers = [];
  jar = "theme=dark; gate_csrf=cookie-token%3D; other=1";
  setCsrfToken(undefined);
  setHttpHooks({});
  setTransport({
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      const next = answers.shift();
      if (!next) throw new Error("no answer queued");
      return next();
    }) as unknown as typeof fetch,
    cookies: () => jar,
  });
});

const header = (i: number, name: string) => (sent[i]!.init.headers as Record<string, string>)[name];

describe("requests", () => {
  it("sends same-origin requests with credentials and JSON, and never to another site", async () => {
    answers.push(json(200, { ok: true }));
    await expect(post("/api/console/rpc", { op: "api.today", args: ["org_demo"] })).resolves.toEqual({ ok: true });
    expect(sent[0]!.url).toBe("/api/console/rpc");
    expect(sent[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify({ op: "api.today", args: ["org_demo"] }) });
    expect(header(0, "content-type")).toBe("application/json");
    await expect(get("https://evil.example/api/me")).rejects.toThrow(/own server/);
    await expect(get("//evil.example/api/me")).rejects.toThrow(/own server/);
    expect(sent).toHaveLength(1);
  });

  it("carries the CSRF token on writes: the session's once known, the double-submit cookie before", async () => {
    expect(cookie("gate_csrf")).toBe("cookie-token=");
    expect(cookie("missing")).toBeUndefined();
    answers.push(json(200, {}), json(200, {}), json(200, {}));
    await post("/api/auth/login", { email: "a@b.c", password: "x" });
    expect(header(0, "x-csrf-token")).toBe("cookie-token=");
    setCsrfToken("session-token");
    expect(csrfToken()).toBe("session-token");
    await del("/api/auth/session");
    expect(header(1, "x-csrf-token")).toBe("session-token");
    await get("/api/me");
    expect(header(2, "x-csrf-token")).toBeUndefined();
    expect(sent[2]!.init.body).toBeUndefined();
  });

  it("returns arrays and empty answers as they are", async () => {
    answers.push(json(200, [1, 2]), () => new Response(null, { status: 200 }));
    await expect(get("/api/x")).resolves.toEqual([1, 2]);
    await expect(get("/api/y")).resolves.toEqual({});
  });
});

describe("refusals", () => {
  it("turns { error } into an HttpError with the server's sentence and its other fields", async () => {
    answers.push(json(403, { error: "Your organisation requires everyone to sign in through its identity provider (SAML).", saml: true }));
    const e = await post("/api/auth/login", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 403, message: "Your organisation requires everyone to sign in through its identity provider (SAML).", data: { saml: true } });
  });

  it("gives a plain sentence when the server gave none", async () => {
    answers.push(() => new Response("<html>boom</html>", { status: 502 }), json(404, {}));
    await expect(get("/api/a")).rejects.toThrow("Something went wrong on our side. Nothing was changed.");
    await expect(get("/api/b")).rejects.toThrow("That was not found.");
  });

  it("says when to try again after a 429, from the answer or the Retry-After header", async () => {
    answers.push(json(429, { error: "Too many requests. Try again in 12 seconds.", retryAfter: 12 }));
    await expect(get("/api/a")).rejects.toMatchObject({ status: 429, retryAfter: 12, message: "Too many requests. Try again in 12 seconds." });
    answers.push(json(429, { error: "Slow down" }, { "retry-after": "30" }));
    await expect(get("/api/a")).rejects.toMatchObject({ retryAfter: 30, message: "Slow down. Try again in 30 seconds." });
    answers.push(json(429, {}, { "retry-after": "1" }));
    await expect(get("/api/a")).rejects.toThrow("Too many requests. Try again in 1 second.");
  });
});

describe("the session", () => {
  it("asks the person to confirm it is them on { reauth: true }, then sends the request once more", async () => {
    const reauth = vi.fn(async () => true);
    setHttpHooks({ reauth });
    answers.push(json(401, { error: "Confirm it's you to continue.", reauth: true }), json(200, { done: 1 }));
    await expect(post("/api/agents/x/keys", { label: "a" })).resolves.toEqual({ done: 1 });
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.init.body).toBe(sent[0]!.init.body);
  });

  it("retries only once, and gives up when the person cancels", async () => {
    setHttpHooks({ reauth: async () => true });
    answers.push(json(401, { reauth: true }), json(401, { error: "Confirm it's you to continue.", reauth: true }));
    await expect(post("/api/x")).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(2);
    setHttpHooks({ reauth: async () => false });
    answers.push(json(401, { reauth: true }));
    await expect(post("/api/x")).rejects.toThrow("Confirm it is you to continue. Nothing was changed.");
  });

  it("never opens the dialog for the dialog's own requests", async () => {
    const reauth = vi.fn(async () => true);
    setHttpHooks({ reauth });
    answers.push(json(401, { reauth: true }));
    await expect(post("/api/auth/session", { password: "x" }, { noReauth: true })).rejects.toMatchObject({ status: 401 });
    expect(reauth).not.toHaveBeenCalled();
  });

  it("signs out on any other 401, except where a 401 is an answer (a wrong password)", async () => {
    const signedOut = vi.fn();
    setHttpHooks({ signedOut });
    answers.push(json(401, { error: "Sign in to continue." }));
    await expect(get("/api/console/state?org=org_demo")).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toHaveBeenCalledTimes(1);
    answers.push(json(401, { error: "That email and password do not match." }));
    await expect(post("/api/auth/login", {}, { noSignOut: true })).rejects.toThrow("That email and password do not match.");
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it("reports a lost connection once, and its return once", async () => {
    const offline = vi.fn();
    const online = vi.fn();
    setHttpHooks({ offline, online });
    answers.push(() => { throw new TypeError("Failed to fetch"); }, () => { throw new TypeError("Failed to fetch"); }, json(200, {}));
    await expect(get("/api/me")).rejects.toBeInstanceOf(NetworkError);
    await expect(get("/api/me")).rejects.toThrow(/cannot be reached/);
    expect(offline).toHaveBeenCalledTimes(1);
    await get("/api/me");
    expect(online).toHaveBeenCalledTimes(1);
  });

  it("passes an abort through as it is", async () => {
    answers.push(() => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    await expect(get("/api/me")).rejects.toMatchObject({ name: "AbortError" });
  });
});

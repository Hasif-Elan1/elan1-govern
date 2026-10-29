import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { forOrg, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The web app in the sovereign profile: OIDC discovery, JWKS and token requests all ask the
// egress gate. The fake identity provider answers on 127.0.0.1 (allow-listed) but puts its token
// endpoint on localhost (not), so sign-in fails at the token request and nothing reaches it.

let server: Server;
let port: number;
let issuer: string;
const hits: string[] = [];
const saved = { profile: process.env.GATE_PROFILE, allow: process.env.EGRESS_ALLOW };
let sso: typeof import("../src/server/sso");

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      return void res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `http://localhost:${port}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}`;
  process.env.GATE_PROFILE = "sovereign";
  process.env.EGRESS_ALLOW = `${process.env.SMTP_HOST ?? "localhost"}:${process.env.SMTP_PORT ?? "1025"},127.0.0.1:${port}`;
  sso = await import("../src/server/sso");
});
afterAll(async () => {
  process.env.GATE_PROFILE = saved.profile;
  process.env.EGRESS_ALLOW = saved.allow;
  server.close();
  await prisma.$disconnect();
});

describe("OIDC under deny-all egress", () => {
  it("checks an issuer only when it is on the allow-list", async () => {
    expect(await sso.checkIssuer(issuer, "gate-client", "s3cret")).toBeNull();
    const before = hits.length;
    expect(await sso.checkIssuer(`http://localhost:${port}`, "gate-client", "s3cret")).toMatch(/localhost:\d+ is not on this deployment's egress allow-list/);
    expect(hits.length).toBe(before);
  });

  it("stops the sign-in at a token endpoint off the allow-list, logs it and raises a health alert", async () => {
    const domain = `${randomBytes(4).toString("hex")}.example`;
    const org = await prisma.org.create({ data: { name: "Sovereign SSO", publicKey: "x", privateKeyEnc: "x" } });
    await forOrg(org.id).ssoConnection.create({
      data: { orgId: org.id, issuer, clientId: "gate-client", clientSecretEnc: sso.sealClientSecret(org.id, "s3cret"), domains: [domain], verifiedDomains: [domain], verifyToken: "tok", enforce: false, defaultRole: "approver" },
    });
    const started = await sso.startSso(`asha@${domain}`);
    expect(started).not.toBeNull();
    const auth = new URL(started!.url);
    const back = new URL(auth.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "c0de");
    back.searchParams.set("state", auth.searchParams.get("state")!);
    await expect(sso.finishSso(back, started!.cookie)).rejects.toThrow(sso.SsoError);
    expect(hits).not.toContain("/token");

    const logs = await forOrg(org.id).egressLog.findMany({ where: { purpose: "oidc" }, orderBy: { at: "asc" } });
    expect(logs.map((l) => [l.host, l.decision])).toEqual([
      ["127.0.0.1", "allowed"],
      ["127.0.0.1", "allowed"],
      ["localhost", "blocked"],
    ]);
    expect(logs[2]).toMatchObject({ port, profile: "sovereign", alerted: true });
    expect(await prisma.healthAlert.findFirst({ where: { orgId: org.id, kind: "egress-blocked" } })).toMatchObject({ message: expect.stringContaining(`localhost:${port} (oidc)`) });
  });
});

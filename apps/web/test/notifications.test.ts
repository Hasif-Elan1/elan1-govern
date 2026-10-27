import { describe, expect, it } from "vitest";
import { CodeBody, maskedNumber, NumberBody, SlackBody, WhatsAppBody } from "../src/lib/notifications";

describe("notification settings bodies", () => {
  it("Slack: token, signing secret and channel id, with plain messages", () => {
    expect(SlackBody.safeParse({ botToken: " xoxb-1234567890-abc ", signingSecret: "0123456789abcdef0123456789abcdef", channelId: "C0123ABC" }).success).toBe(true);
    const bad = SlackBody.safeParse({ botToken: "xoxp-1", signingSecret: "nothex", channelId: "#general" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.message).join(" ")).toMatch(/starts with xoxb-.*App Credentials.*C0123456789/);
    expect(SlackBody.safeParse({ botToken: "xoxb-1234567890-abc", signingSecret: "0123456789abcdef", channelId: "C0123ABC", extra: 1 }).success).toBe(false);
  });
  it("WhatsApp: empty optional fields are dropped", () => {
    const ok = WhatsAppBody.parse({ phoneNumberId: "1098765432109", accessToken: "EAAG0123456789abcdefghij", appSecret: "0123456789abcdef", templateName: "", templateLanguage: "", verifyTemplateName: "" });
    expect(ok).toEqual({ phoneNumberId: "1098765432109", accessToken: "EAAG0123456789abcdefghij", appSecret: "0123456789abcdef" });
    expect(WhatsAppBody.safeParse({ phoneNumberId: "+91 98765", accessToken: "x", appSecret: "z" }).success).toBe(false);
    expect(WhatsAppBody.safeParse({ phoneNumberId: "1098765432109", accessToken: "EAAG0123456789abcdefghij", appSecret: "0123456789abcdef", templateName: "Bad Name" }).success).toBe(false);
    expect(WhatsAppBody.parse({ phoneNumberId: "1098765432109", accessToken: "EAAG0123456789abcdefghij", appSecret: "0123456789abcdef", templateName: "approval_waiting", templateLanguage: "en_US" })).toMatchObject({ templateName: "approval_waiting", templateLanguage: "en_US" });
  });
  it("numbers and codes", () => {
    expect(NumberBody.safeParse({ number: "+91 98765 43210" }).success).toBe(true);
    expect(NumberBody.safeParse({ number: "12" }).success).toBe(false);
    expect(CodeBody.safeParse({ code: "123456" }).success).toBe(true);
    expect(CodeBody.safeParse({ code: "12345a" }).success).toBe(false);
    expect(maskedNumber("3210")).toBe("•••• 3210");
  });
});

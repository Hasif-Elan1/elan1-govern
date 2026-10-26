import { describe, expect, it } from "vitest";
import { displayUrl, WEBHOOK_EVENT_LABELS, WEBHOOK_EVENTS } from "../src/lib/webhooks";

describe("webhook display", () => {
  it("shows host and path, never the query string", () => {
    expect(displayUrl("https://siem.example.com/in/gate?token=secret")).toBe("siem.example.com/in/gate");
    expect(displayUrl("https://siem.example.com/")).toBe("siem.example.com");
    expect(displayUrl("not a url")).toBe("not a url");
  });
  it("labels every event in plain words", () => {
    for (const e of WEBHOOK_EVENTS) expect(WEBHOOK_EVENT_LABELS[e].label).toMatch(/^[A-Z][a-z ]+$/);
  });
});

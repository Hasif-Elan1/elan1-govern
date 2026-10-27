import { signRequest } from "@gate/core";
import { expect, test } from "@playwright/test";
import { Client, signInUI } from "./helpers";

const GATE = process.env.GATE_INTERNAL_URL ?? "http://localhost:4000";

/** Dev-only gate route: a month of resolved demo approvals for the AP bot. */
async function addDemoHistory(orgId: string, actor: string) {
  const path = `/internal/orgs/${orgId}/demo/history`;
  const body = JSON.stringify({ actor });
  const res = await fetch(`${GATE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-gate-signature": signRequest(process.env.INTERNAL_API_SECRET ?? "", "POST", path, body) }, body });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { added: number; suggestions: number };
}

test("a suggestion learned from approvals opens as a draft and is not published", async ({ page }) => {
  const owner = await Client.signUp("owner");
  const org = await owner.send("POST", "/api/orgs", { name: "Suggestion Traders" });
  expect(org.status()).toBe(200);
  const { orgId } = (await org.json()) as { orgId: string };
  expect((await owner.send("POST", "/api/demo")).status()).toBe(200);
  expect(await addDemoHistory(orgId, owner.email)).toEqual({ added: 43, suggestions: 1 });

  // Viewers see it but cannot act on it.
  const viewer = await owner.invite("viewer");
  const html = await (await viewer.get("/rulebooks")).text();
  expect(html).toContain("Raise the no-approval limit for payments from ₹50,000 to ₹1,00,000");
  expect(html).not.toContain("Open as draft");
  expect((await viewer.send("POST", "/api/suggestions", {})).status()).toBe(403);

  await signInUI(page, owner.email);
  await expect(page.getByTestId("suggestions-line")).toHaveText(/1 rule suggestion could save about \d+ approvals a month\./);
  await page.getByRole("link", { name: "See suggestions" }).click();
  await expect(page).toHaveURL(/\/rulebooks$/);
  await expect(page.getByText("1 suggestion", { exact: true })).toBeVisible();
  const card = page.getByTestId("suggestion");
  await expect(card).toContainText("Raise the no-approval limit for payments from ₹50,000 to ₹1,00,000");
  await expect(card).toContainText("people approved all 41 payments over ₹50,000 and up to ₹1,00,000, to 6 vendors (none rejected)");
  await card.getByText("See the change to the rulebook").click();
  await expect(card.getByTestId("suggestion-diff")).toContainText("+     when: { amount_inr: { lte: 100000 } }");

  await card.getByRole("button", { name: "Open as draft" }).click();
  await expect(page).toHaveURL(/\/rulebooks\/ap-bot\?suggestion=/);
  await expect(page.getByTestId("suggested-draft")).toContainText("Draft from a suggestion: Raise the no-approval limit");
  // The builder shows the new rule as an unpublished draft.
  await expect(page.getByTestId("yaml")).toHaveValue(/when: \{ amount_inr: \{ lte: 100000 \} \}/);
  const paySmall = page.locator('[data-testid^="rule-"]').filter({ has: page.locator('input[value="pay-small"]') });
  await expect(paySmall.getByLabel("Amount in rupees")).toHaveValue("100000");
  await expect(page.getByText("Will become version 2.")).toBeVisible();
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("v2")).toHaveCount(0);

  // Still version 1 everywhere, and the suggestion has left the open list.
  await page.goto("/rulebooks");
  await expect(page.getByText(/Version 1, signed/)).toBeVisible();
  await expect(page.getByTestId("suggestion")).toHaveCount(0);
  const activity = (await (await owner.get("/api/activity?decision=admin")).json()) as { items: { title: string }[] };
  expect(activity.items.map((i) => i.title)).toContain("Opened a suggested rule change for ap-bot as a draft");
});

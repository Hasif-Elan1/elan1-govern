import { expect, test, type Page } from "@playwright/test";
import { Client, signInUI } from "./helpers";

/** Click a choice inside one question of the questionnaire. */
const choose = (page: Page, question: string, answer: string) => page.locator(`#q-${question}`).getByText(answer, { exact: true }).click();

test("add an AI system, fill the triage, submit, another admin approves, the tier and receipt show up", async ({ browser }) => {
  const owner = await Client.owner("Governance Traders");
  const admin = await owner.invite("admin");

  // 1. The owner adds a system from the empty inventory.
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await desk.newPage();
  await signInUI(page, owner.email);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Inventory" }).click();
  await expect(page.getByRole("heading", { name: "No AI systems yet" })).toBeVisible();
  await page.getByRole("button", { name: "Add your first AI system" }).click();
  await page.fill("#sys-name", "Support chatbot");
  await page.fill("#sys-purpose", "Answers customer questions on the website and hands hard ones to the support team.");
  await page.fill("#sys-vendor", "ChatCo");
  await page.selectOption("#sys-lifecycle", "live");
  await page.getByRole("group", { name: "Data" }).getByText("Personal", { exact: true }).click();
  await page.getByRole("group", { name: "People affected" }).getByText("Customers", { exact: true }).click();
  await page.getByRole("button", { name: "Add to inventory" }).click();
  await page.waitForURL(/\/inventory\/[^/]+$/);
  await expect(page.getByRole("heading", { name: /Support chatbot/ })).toBeVisible();
  await expect(page.getByText("Not assessed").first()).toBeVisible();

  // 2. Start and fill the AI risk triage.
  await page.getByRole("button", { name: "Start the first assessment" }).click();
  await expect(page.getByText("Draft — needs legal review")).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForURL(/\/assessments\/[^/]+$/);
  await choose(page, "autonomy", "It only gives information or drafts");
  await choose(page, "areas", "None of these");
  await choose(page, "external", "Yes");
  await choose(page, "affected", "Customers");
  await choose(page, "data", "Personal details, such as names, phone numbers or ID numbers");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  // Submitting early points at what is still open.
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByText("3 questions are still open.")).toBeVisible();
  await choose(page, "oversight", "Now and then, by sampling");
  await choose(page, "appeal", "Yes");
  await choose(page, "supplier", "A vendor, and we have their documentation");
  await expect(page.getByText("7 of 56 points")).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByText("Waiting for review").first()).toBeVisible();
  await expect(page.getByText("You submitted this assessment, so someone else has to review it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const url = page.url();

  // 3. Another admin approves it.
  const other = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p2 = await other.newPage();
  await signInUI(p2, admin.email);
  await p2.goto("/assessments");
  await expect(p2.getByText("Waiting for review (1)")).toBeVisible();
  await p2.getByRole("link", { name: /Support chatbot/ }).click();
  await p2.waitForURL(url);
  await p2.fill("#review-note", "Matches what the support team told us.");
  await p2.getByRole("button", { name: "Approve" }).click();
  await expect(p2.getByText("Approved. The system's risk tier is updated.")).toBeVisible();
  await other.close();

  // 4. The owner sees the tier, the next review, and the signed receipts in Activity.
  await page.goto("/inventory");
  const row = page.getByRole("row", { name: /Support chatbot/ });
  await expect(row.getByText("Medium risk")).toBeVisible();
  await expect(row.getByText(/\d{4}$/)).toBeVisible();
  await page.goto("/activity?decision=admin");
  await expect(page.getByText("Approved the AI risk triage for Support chatbot, now medium risk")).toBeVisible();
  await expect(page.getByText("Submitted the AI risk triage for Support chatbot: medium risk")).toBeVisible();
  await page.getByRole("button", { name: /Approved the AI risk triage/ }).first().click();
  await page.getByRole("button", { name: "Verify this receipt" }).click();
  await expect(page.getByText("Signed with this organisation's key")).toBeVisible();
  await desk.close();
});

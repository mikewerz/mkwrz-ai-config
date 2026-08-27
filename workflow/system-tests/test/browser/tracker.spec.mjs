import { expect, test } from "@playwright/test";
import { cleanup, startTracker, stopProcess } from "../support/harness.mjs";

let tracker;

test.beforeAll(async () => {
  tracker = await startTracker();
});

test.afterAll(async () => {
  await stopProcess(tracker?.process);
  await cleanup([tracker?.ticketRoot]);
});

test("loads the production queue and opens ticket creation", async ({ page }) => {
  await page.goto(tracker.baseUrl);
  await expect(page.getByText("Project Tracker", { exact: true })).toBeVisible();
  await expect(page.locator(".topnav button").first()).toContainText("Inbox");
  await page.getByRole("button", { name: /Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Attention" })).toBeVisible();
  await expect(page.getByText("Inbox zero")).toBeVisible();
  await expect(page.getByRole("button", { name: "New ticket" })).toBeVisible();
  await page.getByRole("button", { name: "New ticket" }).click();
  await expect(page.getByRole("heading", { name: /Create work ticket/i })).toBeVisible();
  await expect(page.getByLabel(/Ticket ID/i)).toBeEditable();
});

test("navigates to the production configuration and workflow screens", async ({ page }) => {
  await page.goto(tracker.baseUrl);
  await page.getByRole("button", { name: "Configuration" }).click();
  await expect(page.getByRole("heading", { name: "Configured clone sources" })).toBeVisible();
  await page.getByRole("tab", { name: /Cost & metrics/ }).click();
  await expect(page.getByRole("heading", { name: "Weekly allowances" })).toBeVisible();
  await expect(page.getByText("No subscription quota observations")).toBeVisible();

  await page.getByRole("tab", { name: /Quality & artifacts/ }).click();
  await expect(page.getByRole("heading", { name: "Artifact retention & quotas" })).toBeVisible();

  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workflow editor" })).toBeVisible();
});

test("shows tracker readiness and the Markdown index on the operations page", async ({ page }) => {
  await page.goto(tracker.baseUrl);
  await page.getByRole("button", { name: /Operations/ }).click();
  await expect(page.getByRole("heading", { name: "System operations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tracker readiness" })).toBeVisible();
  await expect(page.getByText(/0\/0 valid · generation/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Background operations" })).toBeVisible();
});

test("shows continuous-intake campaigns, sources, and admission history", async ({ page }) => {
  await page.goto(tracker.baseUrl);
  await page.getByRole("button", { name: "Intake", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Campaigns & intake" })).toBeVisible();
  await page.getByRole("button", { name: "Campaign", exact: false }).click();
  await expect(page.getByLabel("Campaign ID")).toBeEditable();
  await expect(page.getByLabel("New per run")).toHaveValue("100");
  await page.getByLabel("Campaign ID").fill("browser-campaign");
  await page.getByLabel("Campaign name").fill("Browser campaign");
  await page.getByRole("button", { name: "Save definition" }).click();
  await expect(page.getByText("Browser campaign", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Source", exact: false }).click();
  await expect(page.getByLabel("Source campaign")).toHaveValue("browser-campaign");
  await expect(page.getByLabel("Source workflow")).toHaveValue("standard-delivery");
  await expect(page.getByRole("button", { name: "Save & test discovery" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: "Recent candidates" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Source runs" })).toBeVisible();
});

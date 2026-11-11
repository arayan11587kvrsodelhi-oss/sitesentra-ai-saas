// Runs one real scan through the dashboard form, then captures the report.
export default async function run(page, ui) {
  const out = { steps: [] };
  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address").fill("audit-ui@example.com");
  await page.getByLabel("Password", { exact: true }).fill("audit-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 20000 });

  await page.getByLabel("Website to assess").fill("https://example.com");
  await page.getByRole("button", { name: "Run scan" }).click();
  try {
    await page.waitForURL("**/dashboard/scans/**", { timeout: 60000 });
  } catch {
    out.steps.push("scan did not navigate: " + (await page.locator("[role=alert]").allInnerTexts()).join(" | "));
    return out;
  }
  out.steps.push("report: " + page.url());
  await page.waitForTimeout(500);

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    out.steps.push({ width, ...m });
    await page.screenshot({ path: `docs/redesign/screenshots/audit-report-${width}.png`, fullPage: true });
  }

  // Dashboard with data
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "networkidle" });
  await page.screenshot({ path: "docs/redesign/screenshots/audit-dashboard-data-1440.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/redesign/screenshots/audit-dashboard-data-375.png", fullPage: true });
  await page.goto("http://localhost:3000/dashboard/history", { waitUntil: "networkidle" });
  await page.screenshot({ path: "docs/redesign/screenshots/audit-history-data-375.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/redesign/screenshots/audit-history-data-1440.png", fullPage: true });
  return out;
}

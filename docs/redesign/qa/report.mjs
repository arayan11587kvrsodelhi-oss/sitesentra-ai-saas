// Opens the newest report from history and captures it at every width.
export default async function run(page) {
  const out = [];
  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address").fill("audit-ui@example.com");
  await page.getByLabel("Password", { exact: true }).fill("audit-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 20000 });

  await page.goto("http://localhost:3000/dashboard/history", { waitUntil: "networkidle" });
  const href = await page.evaluate(() => document.querySelector('a[href^="/dashboard/scans/"]')?.getAttribute("href") ?? null);
  out.push({ href });
  if (!href) return out;

  for (const w of [375, 390, 430, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`http://localhost:3000${href}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const bad = [...document.querySelectorAll("body *")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1);
        })
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`);
      return { sw: de.scrollWidth, cw: de.clientWidth, bad };
    });
    out.push({ w, ...m });
    if ([375, 768, 1024, 1440, 1920].includes(w)) {
      await page.screenshot({ path: `docs/redesign/screenshots/audit-report-${w}.png`, fullPage: true });
    }
  }
  return out;
}

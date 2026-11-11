// QA driver: signs in, then captures every signed-in surface at several widths.
// Usage: node <skill>/browser.mjs http://localhost:3000/login --script docs/redesign/qa/audit.mjs
const WIDTHS = [375, 390, 430, 768, 1024, 1440, 1920];

export default async function run(page, ui) {
  const out = { steps: [] };

  // ---- sign in -----------------------------------------------------------
  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address").fill("audit-ui@example.com");
  await page.getByLabel("Password", { exact: true }).fill("audit-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 20000 });
  out.steps.push("signed in");

  const pages = [
    ["dashboard", "http://localhost:3000/dashboard"],
    ["history", "http://localhost:3000/dashboard/history"],
    ["landing", "http://localhost:3000/"],
    ["methodology", "http://localhost:3000/methodology"],
  ];

  for (const [name, url] of pages) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForTimeout(250);
      const metrics = await page.evaluate(() => {
        const de = document.documentElement;
        const overflowing = [...document.querySelectorAll("body *")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1);
          })
          .slice(0, 6)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
        return { sw: de.scrollWidth, cw: de.clientWidth, overflowing };
      });
      out.steps.push({ name, width, ...metrics });
      if (width === 375 || width === 1440) {
        await page.screenshot({ path: `docs/redesign/screenshots/audit-${name}-${width}.png`, fullPage: true });
      }
    }
  }

  return out;
}

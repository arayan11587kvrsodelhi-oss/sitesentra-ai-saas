export default async function run(page) {
  const out = [];
  for (const [w, h] of [[375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      bodyH: document.body.scrollHeight,
      cards: [...document.querySelectorAll(".glass-card")].map((e) => Math.round(e.getBoundingClientRect().height)),
      footerTop: Math.round(document.querySelector("footer").getBoundingClientRect().top),
    }));
    out.push({ w, h, ...m });
    if (w === 375 || w === 1440) {
      await page.screenshot({ path: `docs/redesign/screenshots/audit-login-${w}.png`, fullPage: true });
    }
  }
  return out;
}

// One-off screenshot driver. Run from this directory:
//   cd C:\docker\net-core\azure-mcp\docs\screenshots
//   node .shoot.mjs
// (it expects Playwright available — install once with
//  `npm i -g playwright && playwright install chromium`).

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
mkdirSync(OUT, { recursive: true });

const URL = "http://localhost:18080/";
const VIEWPORT = { width: 1600, height: 1000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // Pin the active project to "test" before any screenshot — that's
  // where the seeded topologies live.
  await page.goto(URL);
  const projects = await page
    .request.get(`${URL}api/projects`)
    .then((r) => r.json());
  const test = projects.find((p) => p.name === "test");
  await page.evaluate(
    (id) => localStorage.setItem("azure-mcp:active-project-id", id),
    test.id
  );
  // Clear any stale active topology so the rail loads cleanly.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("azure-mcp:active-topology:"))
        localStorage.removeItem(key);
    }
  });
  await page.reload();
  await page.waitForSelector("text=Topologies", { timeout: 15000 });
  await sleep(800);

  // ── 1. workspace.png ────────────────────────────────────────────
  // Active topology is the most-recently-updated one — kafka-staging
  // (failed). For workspace.png we want a richer, successful one.
  // Click the "vigil-hub-spoke" row in the rail.
  await page.getByText("vigil-hub-spoke").first().click();
  await sleep(1500);
  await page.screenshot({ path: join(OUT, "workspace.png"), fullPage: false });
  console.log("✓ workspace.png");

  // ── 2. build.png ─────────────────────────────────────────────────
  // Same topology view but with the Bicep drawer open.
  await page
    .locator('button:has-text("View Bicep")')
    .first()
    .click({ timeout: 5000 })
    .catch((e) => console.log("  view-bicep click warn:", e.message));
  await sleep(1200);
  await page.screenshot({ path: join(OUT, "build.png"), fullPage: false });
  console.log("✓ build.png");

  // Close the drawer (Esc, then click body).
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
  await page.mouse.click(100, 300).catch(() => {});
  await sleep(400);

  // ── 4. activity.png ─────────────────────────────────────────────
  // Crop to the bottom of the chat panel — activity row + composer.
  // We capture the idle state ("Ready") rather than burn an Anthropic
  // turn just for a screenshot.
  const composerBox = await page
    .locator("textarea")
    .first()
    .boundingBox();
  if (composerBox) {
    const clip = {
      x: Math.max(0, composerBox.x - 16),
      y: Math.max(0, composerBox.y - 60),
      width: Math.min(VIEWPORT.width, composerBox.width + 32),
      height: 150,
    };
    await page.screenshot({ path: join(OUT, "activity.png"), clip });
  } else {
    await page.screenshot({ path: join(OUT, "activity.png") });
  }
  console.log("✓ activity.png");

  // ── 3. push.png ──────────────────────────────────────────────────
  // Switch to the draft topology (openai-chat-app) so Push is enabled,
  // then trigger the confirm dialog. Capture before user dismisses.
  await page.locator('button:has-text("openai-chat-app")').first().click().catch(() => {});
  await sleep(1200);
  // Accept the browser native confirm() should it surface (we already
  // replaced these with styled dialogs but belt + braces).
  page.on("dialog", (d) => d.dismiss());
  await page
    .locator('button:has-text("Push to Azure")')
    .first()
    .click({ timeout: 5000 })
    .catch((e) => console.log("  push click warn:", e.message));
  await sleep(1000);
  await page.screenshot({ path: join(OUT, "push.png"), fullPage: false });
  console.log("✓ push.png");

  // Dismiss the confirm.
  await page
    .locator('button:has-text("Cancel")')
    .first()
    .click()
    .catch(() => {});
  await sleep(400);

  // ── 5. scheduler.png ────────────────────────────────────────────
  await page
    .locator('button:has-text("Schedule")')
    .first()
    .click({ timeout: 5000 })
    .catch((e) => console.log("  schedule click warn:", e.message));
  await sleep(1200);
  await page.screenshot({ path: join(OUT, "scheduler.png"), fullPage: false });
  console.log("✓ scheduler.png");

  await browser.close();
  console.log("\ndone");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

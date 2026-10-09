/**
 * End-to-end tests: real Chrome (puppeteer-core, headless) against the app.
 *
 *   npm run test:ui     — UI flows (no audio)
 *   npm run test:audio  — teach → count → pause/resume → reload, driven by
 *                         synthesized chant audio pushed into the REAL
 *                         pipeline via AudioEngine.__test (features, VAD,
 *                         calibration, DTW matching, UI all production code)
 *   npm run test:e2e    — both
 */
import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clip, compose, rng, haveSay, VOICES, SR } from "./lib/corpus.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");
const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const mode = process.argv[2] || "all";
let failures = 0;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, BASE).pathname);
      let file = path.normalize(path.join(appDir, urlPath === "/" ? "index.html" : urlPath));
      if (!file.startsWith(appDir)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    srv.listen(PORT, "127.0.0.1", () => resolve(srv));
  });
}

function ok(name, cond, extra = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.error(`  ✘ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => "");
const visible = (page, sel) => page.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== "none").catch(() => false);
const countNow = async (page) => parseInt(await text(page, "#count"), 10);
function watchErrors(page) {
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  return errs;
}
async function fresh(browser, viewport = { width: 390, height: 844 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload({ waitUntil: "networkidle0" });
  return page;
}

/* ------------------------------ UI tests ------------------------------ */
async function testUI(browser) {
  console.log("\n── UI ──");
  const page = await fresh(browser);
  const errs = watchErrors(page);

  ok("title", (await page.title()).includes("Jap"));
  ok("108 beads drawn", (await page.$$eval("#beads circle", (n) => n.length)) === 108);
  ok("first run asks to teach the mantra", /Teach/.test(await text(page, "#status-text")) && (await text(page, "#main-label")) === "Teach");

  for (let i = 0; i < 3; i++) await page.click("#btn-plus");
  ok("+1 ×3 → 3", (await countNow(page)) === 3);
  ok("3 beads lit", (await page.$$eval("#beads .bead.on", (n) => n.length)) === 3);
  await page.click("#btn-minus");
  ok("−1 → 2", (await countNow(page)) === 2);

  await page.click("#btn-reset");
  ok("reset asks for confirmation", await visible(page, "#sheet-confirm"));
  ok("…and doesn't reset yet", (await countNow(page)) === 2);
  await page.click("#btn-confirm-yes");
  await sleep(100);
  ok("confirmed reset → 0", (await countNow(page)) === 0);

  await page.click("#btn-settings");
  ok("settings sheet opens", await visible(page, "#sheet-settings"));
  await page.click('#seg-target [data-v="21"]');
  ok("mala size 21 → 21 beads", (await page.$$eval("#beads circle", (n) => n.length)) === 21);
  ok("…and 'of 21'", /of 21/.test(await text(page, "#count-sub")));
  await page.click('.swatch[data-theme="obsidian"]');
  ok("theme switches", (await page.evaluate(() => document.documentElement.dataset.theme)) === "obsidian");
  await page.keyboard.press("Escape");
  await sleep(50);
  ok("Escape closes the sheet", !(await visible(page, "#sheet-settings")));

  await page.click("#btn-mantra");
  ok("mantra sheet lists presets", (await page.$$eval(".mantra-row", (n) => n.length)) >= 5);
  await page.evaluate(() => [...document.querySelectorAll(".mantra-row")].find((b) => b.dataset.mantra === "Hare Krishna").click());
  await sleep(400);
  ok("mantra selected", (await text(page, "#mantra-name")) === "Hare Krishna");
  ok("unknown mantra → teach sheet opens", await visible(page, "#sheet-teach"));
  await page.keyboard.press("Escape");

  await page.click("#btn-mantra");
  await page.type("#custom-mantra", "Om Shanti");
  await page.click("#form-add-mantra button");
  await sleep(400);
  ok("custom mantra added + selected", (await text(page, "#mantra-name")) === "Om Shanti");
  await page.keyboard.press("Escape");

  for (let i = 0; i < 4; i++) await page.click("#btn-plus");
  await page.reload({ waitUntil: "networkidle0" });
  ok("count + mantra survive reload", (await countNow(page)) === 4 && (await text(page, "#mantra-name")) === "Om Shanti");
  ok("theme survives reload", (await page.evaluate(() => document.documentElement.dataset.theme)) === "obsidian");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok("no horizontal overflow at phone width", !overflow);
  await page.setViewport({ width: 320, height: 568 });
  const fits = await page.evaluate(() => {
    const r = document.querySelector("#btn-main").getBoundingClientRect();
    return r.bottom <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth;
  });
  ok("controls fit a small (320×568) phone without scrolling", fits);
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await page.close();
}

/* ----------------------------- audio tests ---------------------------- */
function b64(f32) { return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64"); }
async function pushAudio(page, pcm) {
  const STEP = SR * 4;   // send 4 s per evaluate
  for (let i = 0; i < pcm.length; i += STEP) {
    await page.evaluate((s) => {
      const bin = atob(s), u8 = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
      const f = new Float32Array(u8.buffer);
      for (let k = 0; k < f.length; k += 1024) AudioEngine.__test.push(f.subarray(k, k + 1024));
    }, b64(pcm.slice(i, i + STEP)));
  }
}

async function testAudio(browser) {
  console.log("\n── Audio pipeline (synthesized chanting) ──");
  if (!haveSay()) { console.log("  (skipped: macOS `say` unavailable)"); return; }
  const v = VOICES.rishi;
  const R = rng(7);
  const rate = () => 150 + Math.round(R() * 50);
  const page = await fresh(browser);
  const errs = watchErrors(page);
  await page.evaluate((sr) => AudioEngine.__test.simulate(sr), SR);

  // Teach
  await page.click("#btn-main");
  ok("Start on a new mantra opens Teach", await visible(page, "#sheet-teach"));
  await page.click("#btn-teach-go");
  await sleep(50);
  ok("listening step shown", (await page.$eval("#sheet-teach", (e) => e.dataset.step)) === "listen");
  await pushAudio(page, compose([{ gap: 1.5 }], { noise: 0.002, seed: 1 }));
  ok("REC indicator on after get-ready", (await page.$eval("#rec-pill", (e) => e.dataset.state)) === "rec");
  ok("asks for repetition 1 of 3", /Repetition 1 of 3/.test(await text(page, "#teach-step-title")));
  await pushAudio(page, compose([{ pcm: clip(v.voice, v.mantra, 170) }, { gap: 1.5 }], { noise: 0.002, seed: 2 }));
  await sleep(950);
  await pushAudio(page, compose([{ gap: 0.3 }], { noise: 0.002, seed: 5 }));
  ok("rep 1 recorded → asks for 2 of 3", (await page.$$eval("#rep-steps li.done", (n) => n.length)) === 1 && /Repetition 2 of 3/.test(await text(page, "#teach-step-title")));
  await pushAudio(page, compose([{ pcm: clip(v.voice, v.mantra, 160) }, { gap: 1.5 }, { pcm: clip(v.voice, v.mantra, 180) }, { gap: 1.5 }], { noise: 0.002, seed: 3 }));
  await sleep(100);
  ok("recording stops by itself after 3", (await page.$eval("#sheet-teach", (e) => e.dataset.step)) === "result" && (await page.$eval("#rec-pill", (e) => e.dataset.state)) === "stopped");
  ok("result: learned from 3 repetitions", /learned/i.test(await text(page, "#teach-result-title")) && /3 repetitions/.test(await text(page, "#teach-result-body")), await text(page, "#teach-result-body"));

  // Count
  await page.click("#btn-teach-start");
  await sleep(50);
  ok("counting started", (await page.evaluate(() => window.__app.state().mode)) === "running");
  const live = [];
  for (let i = 0; i < 6; i++) live.push({ pcm: clip(v.voice, v.mantra, rate()) }, { gap: 0.3 + R() });
  live.push({ gap: 1 });
  await pushAudio(page, compose(live, { noise: 0.002, seed: 2 }));
  ok("6 chanted repetitions → 6", (await countNow(page)) === 6, `(got ${await countNow(page)})`);
  ok("6 beads lit", (await page.$$eval("#beads .bead.on", (n) => n.length)) === 6);

  const noise = [];
  for (let i = 0; i < 4; i++) noise.push({ pcm: clip(v.voice, v.half, rate()) }, { gap: 0.8 }, { pcm: clip(v.voice, v.other, rate()) }, { gap: 0.8 });
  await pushAudio(page, compose(noise, { noise: 0.002, seed: 3 }));
  ok("half-mantras and other talk don't count", (await countNow(page)) === 6, `(got ${await countNow(page)})`);

  // Pause / resume
  await page.click("#btn-main");
  await pushAudio(page, compose([{ pcm: clip(v.voice, v.mantra, 170) }, { gap: 1 }], { noise: 0.002 }));
  ok("paused → chanting is ignored", (await countNow(page)) === 6);
  await page.click("#btn-main");
  await sleep(50);
  await pushAudio(page, compose([{ gap: 0.5 }, { pcm: clip(v.voice, v.mantra, 170) }, { gap: 0.6 }, { pcm: clip(v.voice, v.mantra, 185) }, { gap: 1 }], { noise: 0.002, seed: 4 }));
  ok("resumed → counts again (8)", (await countNow(page)) === 8, `(got ${await countNow(page)})`);

  // Reload keeps the learned voice
  await page.reload({ waitUntil: "networkidle0" });
  const st = await page.evaluate(() => window.__app.state());
  ok("after reload: count kept, voice still learned", st.count === 8 && st.hasProfile && st.mode === "paused");
  await page.evaluate((sr) => AudioEngine.__test.simulate(sr), SR);
  await page.click("#btn-main");
  await sleep(50);
  await pushAudio(page, compose([{ gap: 0.5 }, { pcm: clip(v.voice, v.mantra, 165) }, { gap: 1 }], { noise: 0.002, seed: 6 }));
  ok("…and counting continues without re-teaching (9)", (await countNow(page)) === 9);
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await page.close();
}

/* -------------------------------- main -------------------------------- */
(async () => {
  if (!fs.existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME} (set CHROME=…)`); process.exit(1); }
  const srv = await serve();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--autoplay-policy=no-user-gesture-required"] });
  try {
    if (mode === "ui" || mode === "all") await testUI(browser);
    if (mode === "audio" || mode === "all") await testAudio(browser);
  } finally { await browser.close(); srv.close(); }
  console.log(failures === 0 ? "\nAll E2E tests passed ✅" : `\n${failures} test(s) failed ❌`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

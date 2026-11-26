import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const listingDir = resolve("listing");
  await mkdir(listingDir, { recursive: true });

  const tempProfile = resolve(process.env.TEMP || "C:\\Temp", "chrome_shot_profile_" + Date.now());
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

  console.log("Launching headless Chrome on port 9222...");
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=9222",
    `--user-data-dir=${tempProfile}`,
    "--window-size=1280,800",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:5180/"
  ]);

  chrome.on("error", err => console.error("Chrome process error:", err));

  // Wait for remote debugging to be ready
  let targets = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const res = await fetch("http://localhost:9222/json");
      targets = await res.json();
      if (targets && targets.length) break;
    } catch {}
  }

  if (!targets || !targets.length) {
    throw new Error("Failed to connect to Chrome DevTools Protocol at http://localhost:9222/json");
  }

  const pageTarget = targets.find(t => t.type === "page") || targets[0];
  console.log("Connected to page:", pageTarget.title, pageTarget.webSocketDebuggerUrl);

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 1;
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const curId = msgId++;
      const onMsg = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === curId) {
          ws.removeEventListener("message", onMsg);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  async function evalJs(expr) {
    return send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  }

  async function snap(filename) {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const out = resolve(listingDir, filename);
    await writeFile(out, Buffer.from(data, "base64"));
    console.log(`Saved screenshot: ${filename}`);
  }

  await send("Page.enable");
  await send("DOM.enable");

  // Wait for initial load
  await sleep(1500);

  // 1. 01-home-document-input.png
  console.log("Capturing 01-home-document-input.png...");
  await evalJs(`window.location.hash = "#/";`);
  await sleep(600);
  await snap("01-home-document-input.png");

  // Populate sample document and capture pipeline / results
  await evalJs(`
    const sel = document.getElementById("sample-select");
    if (sel) {
      sel.value = "photosynthesis";
      sel.dispatchEvent(new Event("change"));
    }
  `);
  await sleep(500);

  // Click analyze and capture progress
  console.log("Capturing 02-analysis-progress.png...");
  await evalJs(`
    const btn = document.getElementById("analyze-btn");
    if (btn) btn.click();
  `);
  // Pipeline appears immediately
  await sleep(350);
  await snap("02-analysis-progress.png");

  // Wait for analysis to complete and reach #/results
  console.log("Waiting for analysis to complete...");
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const hash = await evalJs(`window.location.hash`);
    if (hash?.value === "#/results") break;
  }
  await sleep(1000);

  // 3. 03-results-summary.png
  console.log("Capturing 03-results-summary.png...");
  await evalJs(`
    const summaryTab = document.querySelector('button[data-tab="summary"]');
    if (summaryTab) summaryTab.click();
  `);
  await sleep(600);
  await snap("03-results-summary.png");

  // 4. 04-summary-modes-and-concepts.png
  console.log("Capturing 04-summary-modes-and-concepts.png...");
  await evalJs(`
    const conceptsTab = document.querySelector('button[data-tab="concepts"]');
    if (conceptsTab) conceptsTab.click();
  `);
  await sleep(600);
  await snap("04-summary-modes-and-concepts.png");

  // 5. 05-action-items-and-study.png
  console.log("Capturing 05-action-items-and-study.png...");
  await evalJs(`
    const actionsTab = document.querySelector('button[data-tab="actions"]');
    if (actionsTab) actionsTab.click();
  `);
  await sleep(300);
  await evalJs(`
    const actBtn = document.getElementById("actions-btn");
    if (actBtn) actBtn.click();
  `);
  await sleep(1000);
  await snap("05-action-items-and-study.png");

  // 6. 06-grounded-follow-up.png
  console.log("Capturing 06-grounded-follow-up.png...");
  await evalJs(`
    const askTab = document.querySelector('button[data-tab="ask"]');
    if (askTab) askTab.click();
  `);
  await sleep(300);
  await evalJs(`
    const qInput = document.getElementById("question");
    if (qInput) {
      qInput.value = "What is the primary role of chlorophyll?";
    }
    const askBtn = document.getElementById("ask-btn");
    if (askBtn) askBtn.click();
  `);
  await sleep(1500);
  await snap("06-grounded-follow-up.png");

  // 7. 07-history.png
  console.log("Capturing 07-history.png...");
  await evalJs(`window.location.hash = "#/history";`);
  await sleep(800);
  await snap("07-history.png");

  // 8. 08-settings.png
  console.log("Capturing 08-settings.png...");
  await evalJs(`window.location.hash = "#/settings";`);
  await sleep(500);
  await evalJs(`
    const checkBtn = document.getElementById("self-check");
    if (checkBtn) checkBtn.click();
  `);
  await sleep(800);
  await snap("08-settings.png");

  // 9. 09-multi-file-queue.png
  console.log("Capturing 09-multi-file-queue.png...");
  await evalJs(`window.location.hash = "#/";`);
  await sleep(500);
  await evalJs(`
    const list = document.getElementById("file-list");
    if (list) {
      list.innerHTML = \`
        <article class="file-item"><div><strong>lecture-notes-week1.txt</strong><span class="badge">Ready</span><div class="muted">text/plain · 12,450 bytes · 2,180 words</div></div><button class="ghost" type="button">Remove</button></article>
        <article class="file-item"><div><strong>research-paper-draft.md</strong><span class="badge">Ready</span><div class="muted">text/markdown · 8,320 bytes · 1,450 words</div></div><button class="ghost" type="button">Remove</button></article>
        <article class="file-item"><div><strong>scanned-diagrams.png</strong><span class="badge basic">Unsupported</span><div class="muted">image/png · 1,240,000 bytes</div><div class="muted">Image/scanned files require text layers. Use TXT, MD, PDF, or Office formats.</div></div><button class="ghost" type="button">Remove</button></article>
      \`;
      const status = document.getElementById("file-status");
      if (status) status.textContent = "2 usable files ready / 3,630 words. Review the extracted text before analyzing.";
    }
  `);
  await sleep(400);
  await snap("09-multi-file-queue.png");

  // 10. 10-file-citation.png
  console.log("Capturing 10-file-citation.png...");
  await evalJs(`window.location.hash = "#/results";`);
  await sleep(500);
  await evalJs(`
    const summaryTab = document.querySelector('button[data-tab="summary"]');
    if (summaryTab) summaryTab.click();
  `);
  await sleep(400);
  await evalJs(`
    const det = document.querySelector("details.citation");
    if (det) det.open = true;
  `);
  await sleep(300);
  await snap("10-file-citation.png");

  console.log("All 10 screenshots captured successfully!");
  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch(err => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});

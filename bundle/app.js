import { createApi } from "./api.js";
import { ingest, INGEST_LIMITS } from "./ingest.js";
import { sampleFiles, sampleTexts } from "./samples.js";

const TOOL_ID = window.__ANNA_TOOL_IDS__?.summarizer || "tool-dev-my-first-anna-app";
let cancelled = false;
let heartbeatTimer = null;
let lastError = null;
let current = { text: "", analysis: null, outputs: {}, critique: null, chat: [], files: [], sourceMap: [] };
let savedHistory = [];
const app = () => document.getElementById("app");
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char]));
const statusBadge = () => document.getElementById("connection-status");
const setConnectionStatus = state => {
  const badge = statusBadge();
  if (!badge) return;
  badge.textContent = state === "connected" ? "Connected" : "Reconnecting";
  badge.className = `status-badge ${state}`;
};
const friendlyError = error => {
  console.error("StudyLens user-visible error", error);
  return error?.message || "The request could not be completed.";
};
const bytesToBase64 = bytes => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
};
const api = createApi({
  toolId: TOOL_ID,
  onStatus: setConnectionStatus,
  onError: error => { lastError = error; },
});
const invoke = (method, args, options) => api.invoke(method, args, options);
async function saveRuntimeState() {
  if (!current.analysis) return;
  try {
    await api.storageSet({ key: "studylens:last-analysis", value: { text: current.text, analysis: current.analysis, outputs: current.outputs, critique: current.critique, chat: current.chat, files: current.files, sourceMap: current.sourceMap } });
  } catch (error) {
    console.error("StudyLens runtime storage unavailable", error);
  }
}
function resumePendingAnalysis() {
  const pending = sessionStorage.getItem("studylens:retry-text");
  if (!pending) return;
  sessionStorage.removeItem("studylens:retry-text");
  window.setTimeout(() => analyze(pending), 250);
}
function setRoute(route) { window.history.replaceState(null, "", `#${route}`); render(); }
function cite(source) {
  if (!source?.snippet) return "";
  const location = [source.file, source.page ? `page ${source.page}` : "", source.slide ? `slide ${source.slide}` : "", source.sheet ? `sheet ${source.sheet}` : "", source.paragraph ? `paragraph ${source.paragraph}` : ""].filter(Boolean).join(" · ");
  return `<details class="citation"><summary>Reference${location ? `: ${escapeHtml(location)}` : ""}</summary><div>${escapeHtml(source.snippet)}</div></details>`;
}
function sourceBadge(source) { return `<span class="badge ${source === "rule-based" ? "basic" : ""}">${source === "rule-based" ? "Basic mode (rule-based)" : source === "cache" ? "Cached result" : "AI-generated"}</span>`; }
function points(analysis) { return (analysis?.keyPoints || []).map(point => typeof point === "string" ? { text: point, source: {} } : point); }
function renderItems(items, field = "text") {
  if (!Array.isArray(items) || !items.length) return `<div class="empty">Nothing to show yet.</div>`;
  return items.map(item => `<article class="item"><strong>${escapeHtml(item[field] || item.text || item.question || item.topic || "Study item")}</strong>${item.answer ? `<p>${escapeHtml(item.answer)}</p>` : ""}${item.priority ? `<span class="badge">${escapeHtml(item.priority)} priority</span>` : ""}${cite(item.source)}</article>`).join("");
}
function renderHome() {
  app().innerHTML = `<section class="hero"><div class="card"><span class="eyebrow">AI study workspace</span><h2>Turn one document into a learning kit</h2><p>Paste lecture notes, an article, transcript, or report. StudyLens stays grounded in your source and shows citations instead of guessing.</p><div class="notice">Every generated block is labelled. Unsupported questions receive “Not found in your document.”</div></div><div class="card"><h3>How it works</h3><p>1. Analyze the source</p><p>2. Generate summaries and practice</p><p>3. Verify claims against passages</p><p>4. Save your study kit</p></div></section>
  <section class="card"><h2>New analysis</h2><label for="source-text"><strong>Document text</strong></label><textarea id="source-text" placeholder="Paste text or add any file...">${escapeHtml(current.text)}</textarea><div class="input-meta muted"><span id="count">0 characters</span><span>Text limit: ${INGEST_LIMITS.maxTextChars.toLocaleString()} characters</span></div><div id="file-status" class="muted">0 usable files ready / 0 characters</div><div id="dropzone" class="dropzone" tabindex="0" role="button" aria-label="Add files by dropping, choosing, or pasting">Drop any file here, or <button id="file-btn" class="ghost" type="button">choose files</button><input id="file-input" type="file" multiple hidden><div class="muted">You can also paste text or clipboard files. Files are processed locally; extracted text is sent only when you start analysis.</div></div><details><summary>Supported formats and limits</summary><p class="muted">Full: TXT, MD, CSV/TSV, JSON, XML, HTML, source code, DOCX, PPTX, XLSX, ODT, EPUB, and text-layer PDF. Partial: large tables are sampled; PDF pages are cited individually. Scanned PDFs, images/OCR, legacy binary Office files, audio/video, and arbitrary ZIP archives are not supported offline.</p><p class="muted">Maximum ${INGEST_LIMITS.maxFileBytes / 1024 / 1024} MB per file and ${INGEST_LIMITS.maxTotalBytes / 1024 / 1024} MB total.</p></details><div id="file-list" class="file-list"></div><div class="actions"><label>Try a sample <select id="sample-select"><option value="">Choose a document</option><option value="random">Surprise me</option>${sampleFiles.map(([id,label]) => `<option value="${id}">${label}</option>`).join("")}</select></label><button id="analyze-btn" type="button">Analyze document</button></div><p id="home-status" class="muted" aria-live="polite">${api.isConnected() ? "Ready." : "Connecting to Anna..."}</p></section>`;
  const text = document.getElementById("source-text");
  const count = document.getElementById("count");
  const updateCount = () => { count.textContent = `${text.value.length.toLocaleString()} characters`; };
  text.addEventListener("input", updateCount); updateCount();
  document.getElementById("sample-select").onchange = async event => {
    const selected = event.target.value;
    if (!selected) return;
    const id = selected === "random" ? sampleFiles[Math.floor(Math.random() * sampleFiles.length)][0] : selected;
    text.value = sampleTexts[id] || ""; updateCount();
  };
  document.getElementById("file-btn").onclick = () => document.getElementById("file-input").click();
  document.getElementById("file-input").onchange = event => addFiles(event.target.files, text, updateCount);
  const dropzone = document.getElementById("dropzone");
  dropzone.ondragover = event => { event.preventDefault(); dropzone.classList.add("drag"); };
  dropzone.ondragleave = () => dropzone.classList.remove("drag");
  dropzone.ondrop = event => { event.preventDefault(); dropzone.classList.remove("drag"); addFiles(event.dataTransfer.files, text, updateCount); };
  dropzone.onpaste = event => { if (event.clipboardData?.files?.length) { event.preventDefault(); addFiles(event.clipboardData.files, text, updateCount); } };
  text.onpaste = event => { if (event.clipboardData?.files?.length) { event.preventDefault(); addFiles(event.clipboardData.files, text, updateCount); } };
  document.getElementById("analyze-btn").onclick = () => analyze(text.value);
  renderFileList();
}
async function addFiles(files, text, updateCount) {
  const status = document.getElementById("file-status");
  if (!files?.length) return;
  status.textContent = `Reading ${files.length} file${files.length === 1 ? "" : "s"} locally...`;
  status.className = "muted";
  const results = await ingest(files, {
    parsePdf: async (bytes, file) => {
      const response = await invoke("parse_pdf", { data: bytesToBase64(bytes), name: file.name });
      return response;
    },
  });
  current.files = [...current.files, ...results];
  const usable = current.files.filter(item => item.status === "ok" && item.text);
  let offset = 0;
  current.sourceMap = usable.map(item => {
    const header = `--- ${item.name} ---\n`;
    const entries = (item.sourceMap?.length ? item.sourceMap : [{ file: item.name, section: item.detectedKind, start: 0, end: item.text.length, snippet: item.text.slice(0, 240) }]).map(source => ({ ...source, file: item.name, start: offset + header.length + source.start, end: offset + header.length + source.end }));
    offset += header.length + item.text.length + 2;
    return entries;
  }).flat();
  text.value = usable.map(item => `--- ${item.name} ---\n${item.text}`).join("\n\n");
  updateCount();
  const words = usable.reduce((sum, item) => sum + item.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const pages = usable.reduce((sum, item) => sum + (item.pages?.length || 0), 0);
  status.textContent = `${usable.length} usable file${usable.length === 1 ? "" : "s"} ready / ${words.toLocaleString()} words / ${pages || "page count unavailable"} pages. Review the extracted text before analyzing.`;
  renderFileList();
}
function renderFileList() {
  const target = document.getElementById("file-list");
  if (!target) return;
  const labels = { ok: "Ready", partial: "Partial", unsupported: "Unsupported", failed: "Failed" };
  target.innerHTML = current.files.map((item, index) => `<article class="file-item"><div><strong>${escapeHtml(item.name)}</strong><span class="badge ${item.status !== "ok" ? "basic" : ""}">${labels[item.status] || "Failed"}</span><div class="muted">${escapeHtml(item.detectedKind)} · ${item.size.toLocaleString()} bytes${item.status === "ok" ? ` · ${item.text.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words · ${item.pages?.length || "page count unavailable"} pages` : ""}</div>${item.warnings?.map(warning => `<div class="muted">${escapeHtml(warning)}</div>`).join("") || ""}</div><button class="ghost remove-file" data-index="${index}" type="button">Remove</button></article>`).join("");
  target.querySelectorAll(".remove-file").forEach(button => button.onclick = () => { current.files.splice(Number(button.dataset.index), 1); renderFileList(); });
}
function pipeline() { return `<section class="card"><h2>Analysis pipeline</h2><div class="progress"><div id="step-analyze" class="step">1. Analyze</div><div id="step-generate" class="step">2. Generate</div><div id="step-verify" class="step">3. Verify</div><div id="step-save" class="step">4. Save</div></div><button id="cancel-btn" class="secondary" type="button">Cancel</button><button id="retry-btn" class="secondary" type="button" hidden>Retry failed step</button><p id="progress-status" class="muted">Starting...</p></section>`; }
function setStep(id, state) { const element = document.getElementById(id); if (element) element.className = `step ${state}`; }
async function analyze(rawText) {
  const text = rawText.trim();
  const status = document.getElementById("home-status");
  if (!text) return status && (status.textContent = "Paste or upload a document first.", status.className = "error");
  if (text.length < 20) return status && (status.textContent = "Please provide at least 20 characters.", status.className = "error");
  if (text.length > 120000) return status && (status.textContent = "This document is over the 120,000-character limit.", status.className = "error");
  cancelled = false; current = { text, analysis: null, outputs: {}, critique: null, chat: [], files: current.files, sourceMap: current.sourceMap };
  app().innerHTML = pipeline();
  document.getElementById("cancel-btn").onclick = () => { cancelled = true; document.getElementById("progress-status").textContent = "Cancellation requested..."; };
  let active = "step-analyze";
  let retryFailed = null;
  let failedStep = null;
  const runAnalyze = async () => {
    setStep(active, "active");
    let cursor = 0;
    let combined = null;
    do {
      const result = await invoke("analyze_document", { text, cursor, max_chunks: 3, source_map: current.sourceMap });
      const part = result.analysis || {};
      combined = combined || { ...part, keyPoints: [], entities: [], definitions: [], openQuestions: [], chunks: [] };
      for (const key of ["keyPoints", "entities", "definitions", "openQuestions", "chunks"]) combined[key].push(...(part[key] || []));
      combined.title = combined.title || part.title;
      combined.sourceLength = part.sourceLength;
      cursor = result.nextCursor ?? 0;
    } while (cursor && !cancelled);
    current.analysis = combined;
    if (cancelled) throw new Error("Analysis cancelled.");
    setStep(active, "done");
  };
  const runGenerate = async () => {
    active = "step-generate"; setStep(active, "active");
    document.getElementById("progress-status").textContent = "Generating a grounded summary...";
    const summary = await invoke("generate_summary", { analysis: current.analysis, mode: "short" });
    current.outputs.short = summary.output;
    if (cancelled) throw new Error("Analysis cancelled.");
    setStep(active, "done");
  };
  const runVerify = async () => {
    active = "step-verify"; setStep(active, "active");
    document.getElementById("progress-status").textContent = "Checking the draft against the source...";
    current.critique = (await invoke("verify_and_refine", { source_text: text, draft: current.outputs.short })).critique;
    setStep(active, "done");
  };
  const runSave = async () => {
    active = "step-save"; setStep(active, "active");
    document.getElementById("progress-status").textContent = "Saving your study kit...";
    await invoke("save_analysis", { title: (current.analysis.title || text.slice(0, 60)), analysis: current });
    await saveRuntimeState();
    setStep(active, "done");
  };
  try {
    retryFailed = async () => {
      if (failedStep === "step-analyze") await runAnalyze();
      if (failedStep === "step-analyze" || failedStep === "step-generate") await runGenerate();
      if (failedStep !== "step-save") await runVerify();
      await runSave();
      setRoute("/results"); await loadHistory();
    };
    await runAnalyze(); await runGenerate(); await runVerify(); await runSave();
    setRoute("/results"); await loadHistory();
  } catch (error) {
    failedStep = active;
    setStep(active, "failed");
    const progressStatus = document.getElementById("progress-status");
    if (progressStatus) { progressStatus.textContent = friendlyError(error); progressStatus.className = "error"; }
    const retry = document.getElementById("retry-btn");
    if (retry) { retry.hidden = false; retry.onclick = async () => {
      retry.hidden = true;
      if (error.kind === "session_expired") {
        sessionStorage.setItem("studylens:retry-text", current.text);
        window.parent.location.reload();
        return;
      }
      try { await retryFailed(); } catch (retryError) { setStep(active, "failed"); progressStatus.textContent = friendlyError(retryError); progressStatus.className = "error"; retry.hidden = false; }
    }; }
  }
}
function renderResults() {
  if (!current.analysis) return setRoute("/");
  app().innerHTML = `<section class="card"><span class="eyebrow">Study kit</span><h2>${escapeHtml(current.analysis.title || "Your document")}</h2><p>${current.analysis.sourceLength?.toLocaleString() || 0} characters · grounded outputs</p><div class="tabs" role="tablist">${["summary","concepts","actions","study","quiz","ask","verification"].map((tab,index) => `<button class="tab ${index === 0 ? "active" : ""}" data-tab="${tab}" type="button">${tab[0].toUpperCase()+tab.slice(1)}</button>`).join("")}</div><div id="result-panel"></div></section>`;
  document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => { document.querySelectorAll("[data-tab]").forEach(item => item.classList.remove("active")); button.classList.add("active"); renderPanel(button.dataset.tab); });
  renderPanel("summary");
}
function renderPanel(tab) {
  const panel = document.getElementById("result-panel"); if (!panel) return;
  if (tab === "summary") { const output = current.outputs.short || {}; panel.innerHTML = `<div class="actions">${["short","detailed","bullets","simple","exam_notes"].map(mode => `<button class="secondary mode-btn" data-mode="${mode}" type="button">${mode.replace("_"," ")}</button>`).join("")}<button id="copy-btn" class="secondary" type="button">Copy</button><button id="export-md-btn" class="secondary" type="button">Export Markdown</button><button id="export-txt-btn" class="secondary" type="button">Export text</button></div><p>${sourceBadge(output.aiGenerated ? "AI-generated" : "rule-based")}</p><div class="grid">${renderItems(output.items)}</div>`; document.querySelectorAll(".mode-btn").forEach(button => button.onclick = () => generateSummary(button.dataset.mode)); document.getElementById("copy-btn").onclick = () => navigator.clipboard.writeText((output.summary || points(current.analysis).map(item => item.text).join(" "))); document.getElementById("export-md-btn").onclick = () => exportCurrent("markdown"); document.getElementById("export-txt-btn").onclick = () => exportCurrent("text"); return; }
  if (tab === "concepts") { panel.innerHTML = `<h3>Key concepts</h3><div class="grid">${renderItems(points(current.analysis))}</div>`; return; }
  if (tab === "actions") { panel.innerHTML = `<div class="actions"><button id="actions-btn" type="button">Generate study plan</button></div><div id="actions-panel" class="grid"><div class="empty">Generate prioritized action items and a study plan.</div></div>`; document.getElementById("actions-btn").onclick = () => generateOutput("generate_action_items", {}, "actions-panel"); return; }
  if (tab === "study") { panel.innerHTML = `<div class="actions"><button id="cards-btn" type="button">Generate flashcards</button></div><div id="study-panel"><div class="empty">Create source-linked flashcards.</div></div>`; document.getElementById("cards-btn").onclick = () => generateOutput("generate_flashcards", { count: 10 }, "study-panel"); return; }
  if (tab === "quiz") { panel.innerHTML = `<div class="actions"><button id="quiz-btn" type="button">Start quiz</button>${current.quizMastery?.weakAreas?.length ? `<button id="retry-weak-btn" class="secondary" type="button">Retry weak concepts</button>` : ""}</div><div id="quiz-panel"><div class="empty">Quiz coverage will be shown after generation.</div></div>`; document.getElementById("quiz-btn").onclick = () => startQuiz([]); if (document.getElementById("retry-weak-btn")) document.getElementById("retry-weak-btn").onclick = () => startQuiz(current.quizMastery.weakAreas); return; }
  if (tab === "ask") { panel.innerHTML = `<h3>Ask questions</h3><p class="muted">Answers are grounded in this document and cite source passages.</p><div id="chat-panel">${current.chat.map(message => `<div class="chat-message"><strong>${message.role === "user" ? "You" : "StudyLens"}</strong><p>${escapeHtml(message.text)}</p>${cite(message.source)}</div>`).join("")}</div><textarea id="question" placeholder="What is the main conclusion?"></textarea><button id="ask-btn" type="button">Ask question</button>`; document.getElementById("ask-btn").onclick = askQuestion; return; }
  panel.innerHTML = `<h3>Verification</h3>${renderVerification(current.critique)}`;
}
async function generateSummary(mode) { try { const result = await invoke("generate_summary", { analysis: current.analysis, mode }); current.outputs[mode] = result.output; renderPanel("summary"); } catch (error) { document.getElementById("result-panel").insertAdjacentHTML("afterbegin", `<div class="error">${escapeHtml(friendlyError(error))}</div>`); } }
async function generateOutput(method, args, targetId) { const target = document.getElementById(targetId); target.innerHTML = `<div class="muted">Generating...</div>`; try { const result = await invoke(method, { analysis: current.analysis, ...args }); current.outputs[method] = result.output; target.innerHTML = method === "generate_flashcards" ? renderItems(result.output.cards, "question") : renderItems(result.output.items || result.output.studyPlan, method === "generate_action_items" ? "task" : "topic"); } catch (error) { target.innerHTML = `<div class="error">${escapeHtml(friendlyError(error))}</div>`; } }
async function startQuiz(weakConcepts = []) { const target = document.getElementById("quiz-panel"); target.innerHTML = `<div class="muted">Generating ${weakConcepts.length ? "a weak-concept retry quiz" : "quiz"}...</div>`; try { const result = await invoke("generate_quiz", { analysis: current.analysis, count: 5, weak_concepts: weakConcepts }); current.outputs.quiz = result.output; target.innerHTML = `<p>${escapeHtml(result.output.coverage?.label || "Coverage calculated")}</p>${weakConcepts.length ? `<div class="notice">Focused on: ${escapeHtml(weakConcepts.join(", "))}</div>` : ""}${(result.output.questions || []).map(question => `<article class="item"><strong>${escapeHtml(question.question)}</strong>${question.options?.length ? question.options.map(option => `<label><input type="radio" name="q-${question.id}" value="${escapeHtml(option)}"> ${escapeHtml(option)}</label><br>`).join("") : `<input data-answer="${question.id}" placeholder="Your answer">`}</article>`).join("")}<button id="grade-btn" type="button">Grade quiz</button>`; document.getElementById("grade-btn").onclick = gradeQuiz; } catch (error) { target.innerHTML = `<div class="error">${escapeHtml(friendlyError(error))}</div>`; } }
async function gradeQuiz() { const quiz = current.outputs.quiz; const answers = {}; (quiz.questions || []).forEach(question => { const selected = document.querySelector(`input[name="q-${question.id}"]:checked`) || document.querySelector(`[data-answer="${question.id}"]`); if (selected) answers[question.id] = selected.value; }); try { const result = await invoke("grade_quiz", { quiz, answers }); current.quizMastery = { ...result, weakAreas: result.weakAreas || [] }; const stats = Object.entries(result.conceptStats || {}).map(([concept, value]) => `${escapeHtml(concept)}: ${value.mastery}%`).join(" · "); document.getElementById("quiz-panel").insertAdjacentHTML("afterbegin", `<div class="notice">Score: ${result.score}/${result.total} (${result.percentage}%). ${result.weakAreas?.length ? `Review: ${escapeHtml(result.weakAreas.join(", "))}<br><button id="retry-inline-btn" class="secondary" type="button">Retry weak concepts</button>` : "Great work!"}<br><span class="muted">Concept mastery: ${stats || "No concept data yet."}</span></div>`); if (result.weakAreas?.length) document.getElementById("retry-inline-btn").onclick = () => startQuiz(result.weakAreas); } catch (error) { document.getElementById("quiz-panel").insertAdjacentHTML("afterbegin", `<div class="error">${escapeHtml(friendlyError(error))}</div>`); } }
function renderVerification(value) { const missing = value?.missingPoints || []; const unsupported = value?.unsupportedClaims || []; const changes = value?.changes || []; const issueCount = missing.length + unsupported.length; return `<p><span class="badge ${issueCount ? "basic" : ""}">${issueCount ? `${issueCount} issue${issueCount === 1 ? "" : "s"} found` : "Verified"}</span></p><details open><summary>What changed</summary>${renderItems(changes.map(change => ({ text: typeof change === "string" ? change : "Revision applied" })))}</details>${missing.length ? `<h3>Missing points</h3>${renderItems(missing.map(item => ({ text: item })))}` : ""}${unsupported.length ? `<h3>Unsupported claims</h3>${renderItems(unsupported.map(item => ({ text: item })))}` : ""}`; }
async function askQuestion() { const input = document.getElementById("question"); const question = input.value.trim(); if (!question) return; current.chat.push({ role: "user", text: question }); renderPanel("ask"); try { const result = await invoke("ask_question", { source_text: current.text, analysis: current.analysis, question, history: current.chat }); const answer = result.answer || {}; current.chat.push({ role: "assistant", text: answer.answer || "Not found in your document.", source: answer.evidence?.[0] }); renderPanel("ask"); } catch (error) { current.chat.push({ role: "assistant", text: friendlyError(error) }); renderPanel("ask"); } }
async function exportCurrent(format) { try { const result = await invoke("export_analysis", { analysis: current.analysis, format }); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([result.content], { type: "text/markdown" })); link.download = `studylens-analysis.${format === "markdown" ? "md" : "txt"}`; link.click(); URL.revokeObjectURL(link.href); } catch (error) { console.error(error); } }
async function loadHistory() { try { savedHistory = (await invoke("list_analyses", {})).analyses || []; } catch (error) { console.error("History unavailable", error); } }
function renderHistory() { app().innerHTML = `<section class="card"><span class="eyebrow">Your workspace</span><h2>History</h2><p>Reopen a saved learning kit without losing your source.</p><input id="history-search" placeholder="Search analyses" aria-label="Search analyses"><div id="history-panel" style="margin-top:14px"></div></section>`; const draw = list => { document.getElementById("history-panel").innerHTML = list.length ? list.map(item => `<article class="history-item"><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.createdAt || "")}</small></div><div class="actions"><button class="secondary open-history" data-id="${escapeHtml(item.id)}" type="button">Open</button><button class="secondary rename-history" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" type="button">Rename</button><button class="secondary delete-history" data-id="${escapeHtml(item.id)}" type="button">Delete</button></div></article>`).join("") : `<div class="empty">No saved analyses yet. Start a new analysis to build your history.</div>`; document.querySelectorAll(".open-history").forEach(button => button.onclick = () => openHistory(button.dataset.id)); document.querySelectorAll(".rename-history").forEach(button => button.onclick = () => renameHistory(button.dataset.id, button.dataset.title)); document.querySelectorAll(".delete-history").forEach(button => button.onclick = () => deleteHistory(button.dataset.id)); }; draw(savedHistory); document.getElementById("history-search").oninput = event => draw(savedHistory.filter(item => item.title.toLowerCase().includes(event.target.value.toLowerCase()))); }
async function renameHistory(id, oldTitle) { const title = window.prompt("New analysis title", oldTitle); if (!title || title.trim() === oldTitle) return; try { await invoke("rename_analysis", { id, title: title.trim() }); await loadHistory(); renderHistory(); } catch (error) { window.alert(friendlyError(error)); } }
async function deleteHistory(id) { if (!window.confirm("Delete this saved analysis? This cannot be undone.")) return; try { await invoke("delete_analysis", { id }); await loadHistory(); renderHistory(); } catch (error) { window.alert(friendlyError(error)); } }
async function openHistory(id) { try { const result = await invoke("get_analysis", { id }); current = result.analysis?.analysis || result.analysis || current; setRoute("/results"); } catch (error) { alert(friendlyError(error)); } }
function renderSettings() { app().innerHTML = `<section class="card"><span class="eyebrow">Preferences</span><h2>Settings</h2><div class="settings-row"><span>Default summary style</span><select><option>Short</option><option>Detailed</option><option>Exam notes</option></select></div><div class="settings-row"><span>Text size</span><select><option>Comfortable</option><option>Large</option></select></div><div class="settings-row"><span>Data</span><span class="muted">Analyses are saved by the Executa history service.</span></div><h3>Diagnostics</h3><div class="settings-row"><span>Bridge</span><span>${api.isConnected() ? "Connected" : "Reconnecting"}</span></div><div class="settings-row"><span>Last error</span><span class="muted">${escapeHtml(lastError?.message || "None")}</span></div><button id="self-check" type="button">Run self-check</button><div id="self-check-result" class="muted"></div><div class="notice" style="margin-top:18px">StudyLens uses only your supplied document for grounded study outputs. AI-generated content is labelled.</div></section>`; document.getElementById("self-check").onclick = async () => { const result = await api.health(); document.getElementById("self-check-result").textContent = result.connected ? "Runtime and plugin are ready." : friendlyError(result.error); }; }
async function render() { const route = location.hash.slice(1) || "/"; document.querySelectorAll("[data-route]").forEach(button => button.classList.toggle("active", button.dataset.route === route)); if (route === "/results") renderResults(); else if (route === "/history") { await loadHistory(); renderHistory(); } else if (route === "/settings") renderSettings(); else renderHome(); }
document.addEventListener("click", event => { const button = event.target.closest("[data-route]"); if (button) { event.preventDefault(); setRoute(button.dataset.route); } });
window.addEventListener("hashchange", render);
try { await api.connect(); await api.setTitle("StudyLens AI"); } catch (error) { lastError = error; console.error("Anna connection unavailable", error); }
render();
const heartbeat = async () => { const result = await api.health(); if (!result.connected) setConnectionStatus("reconnecting"); };
heartbeat();
heartbeatTimer = window.setInterval(heartbeat, 30000);
resumePendingAnalysis();

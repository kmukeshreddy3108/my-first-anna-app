import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const TOOL_ID = window.__ANNA_TOOL_IDS__?.summarizer || "tool-dev-my-first-anna-app";
const sampleText = "Renewable energy is becoming more affordable as solar and wind technology improves. Governments are investing in clean power to reduce emissions, but reliable storage remains a challenge. The report recommends expanding grid infrastructure and supporting research into batteries.";
let anna = null;
let appReady = false;
let recoveringSession = sessionStorage.getItem("studylens.sessionRecovery") === "1";
let current = { text: "", analysis: null, outputs: {}, critique: null };
const $ = id => document.getElementById(id);
const setStatus = (text, error = false) => { $("status").textContent = text; $("status").className = error ? "error" : "muted"; };
const setStep = (id, state) => { const el = $(id); el.className = `step ${state}`; };
const unwrap = response => response?.data || response?.result?.data || response || {};
const isSessionError = error => /unknown session[_ ]id|session expired|invalid session/i.test(error?.message || "");

async function invoke(method, args) {
  if (!anna || !appReady) throw new Error("Connecting to Anna. Please try again in a moment.");
  const response = await anna.tools.invoke({ tool_id: TOOL_ID, method, args, timeoutMs: 120000 });
  const data = unwrap(response);
  if (data.success === false) throw new Error(data.error || "The tool returned an error.");
  return data;
}

function pretty(value) { return JSON.stringify(value, null, 2); }
function activeText() { return $("source-text").value.trim(); }
function showTab(name) {
  document.querySelectorAll(".tab").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  document.querySelectorAll(".tab-content").forEach(panel => { panel.hidden = panel.id !== `tab-${name}`; });
}
function markdown() {
  return `# StudyLens AI analysis\n\n## Analysis\n\n${pretty(current.analysis)}\n\n## Outputs\n\n${Object.entries(current.outputs).map(([mode, output]) => `### ${mode}\n\n${pretty(output)}`).join("\n\n")}\n\n## Verification\n\n${pretty(current.critique)}`;
}
function downloadMarkdown() {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown" }));
  link.download = "studylens-analysis.md";
  link.click();
  URL.revokeObjectURL(link.href);
}
async function loadHistory() {
  try {
    const data = await invoke("list_analyses", {});
    const list = data.analyses || [];
    $("history-list").innerHTML = list.length ? list.map(item => `<div class="history-item"><span>${item.title}</span><small>${item.createdAt}</small></div>`).join("") : "No saved analyses yet.";
  } catch (error) { $("history-list").textContent = error.message; }
}
async function analyze() {
  const text = activeText();
  if (!text) return setStatus("Paste a document first.", true);
  if (!appReady) return setStatus("Connecting to Anna. Please try again in a moment.", true);
  $("analyze-btn").disabled = true; $("progress-card").hidden = false; $("results-card").hidden = true;
  current = { text, analysis: null, outputs: {}, critique: null };
  try {
    setStep("step-analyze", "active"); setStatus("Analyzing document structure, entities, definitions, and open questions...");
    const analyzed = await invoke("analyze_document", { text });
    current.analysis = analyzed.analysis; $("analysis-output").textContent = pretty(current.analysis);
    setStep("step-analyze", "done"); setStep("step-output", "active");
    const summary = await invoke("generate_outputs", { analysis: current.analysis, mode: "short" });
    current.outputs.short = summary.output; $("analysis-output").textContent = pretty(summary.output);
    setStep("step-output", "done"); setStep("step-critique", "active"); setStatus("Checking the draft against the source...");
    const critique = await invoke("critique_and_refine", { source_text: text, draft: summary.output });
    current.critique = critique.critique; $("critique-output").textContent = pretty(current.critique);
    setStep("step-critique", "done"); $("results-card").hidden = false; setStatus(`${summary.source || analyzed.source || "AI-generated"} result ready. Check the verification panel before relying on it.`);
    await invoke("save_analysis", { title: text.slice(0, 60), analysis: current });
    setStep("step-save", "done"); await loadHistory();
    sessionStorage.removeItem("studylens.sessionRecovery");
  } catch (error) {
    if (isSessionError(error) && !recoveringSession) {
      recoveringSession = true;
      sessionStorage.setItem("studylens.pendingText", text);
      sessionStorage.setItem("studylens.sessionRecovery", "1");
      setStatus("Session expired, reconnecting…", true);
      window.top.location.reload();
      return;
    }
    sessionStorage.removeItem("studylens.sessionRecovery");
    setStatus(error.message || "Analysis failed.", true);
  }
  finally { $("analyze-btn").disabled = false; }
}
async function generate(mode) {
  if (!current.analysis) return;
  const target = mode === "actions" ? $("actions-output") : mode === "flashcards" || mode === "quiz" ? $("study-output") : $("analysis-output");
  target.textContent = "Generating...";
  try { const result = await invoke("generate_outputs", { analysis: current.analysis, mode }); current.outputs[mode] = result.output; target.textContent = pretty(result.output); }
  catch (error) { target.textContent = error.message; }
}
async function ask() {
  const question = $("question").value.trim();
  if (!question) return $("answer-output").textContent = "Enter a question first.";
  $("answer-output").textContent = "Checking the document...";
  try { const result = await invoke("ask_followup", { source_text: current.text, analysis: current.analysis, question, history: [] }); $("answer-output").textContent = pretty(result.answer); }
  catch (error) { $("answer-output").textContent = error.message; }
}
async function main() {
  try {
    anna = await AnnaAppRuntime.connect();
    await anna.window.set_title({ title: "StudyLens AI" });
    await anna.window.ready();
    appReady = true;
    $("analyze-btn").disabled = false;
    setStatus("Ready. AI-generated content is labelled and verified.");
  }
  catch { setStatus("Preview mode: open this bundle inside Anna for AI sampling."); }
  $("sample-btn").onclick = () => { $("source-text").value = sampleText; setStatus("Sample loaded. You can edit it before analyzing."); };
  $("analyze-btn").onclick = analyze; $("ask-btn").onclick = ask; $("copy-btn").onclick = () => navigator.clipboard.writeText(markdown());
  $("export-btn").onclick = downloadMarkdown; document.querySelectorAll(".tab").forEach(button => button.onclick = () => showTab(button.dataset.tab));
  document.querySelectorAll("[data-mode]").forEach(button => button.onclick = () => generate(button.dataset.mode));
  await loadHistory();
  const pendingText = sessionStorage.getItem("studylens.pendingText");
  if (pendingText && appReady) {
    sessionStorage.removeItem("studylens.pendingText");
    sessionStorage.setItem("studylens.sessionRecovery", "1");
    $("source-text").value = pendingText;
    setStatus("Reconnected. Retrying your analysis…");
    analyze();
  }
}
main();

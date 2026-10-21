import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const TOOL_ID = "tool-dev-my-first-anna-app";

async function main() {
  const status = document.getElementById("status");
  const form = document.getElementById("summary-form");
  const input = document.getElementById("source-text");
  const button = document.getElementById("generate-btn");
  const resultPanel = document.getElementById("result-panel");
  const result = document.getElementById("result");
  if (!status || !form || !input || !button || !resultPanel || !result) return;

  let anna;
  try {
    anna = await AnnaAppRuntime.connect();
  } catch (e) {
    status.textContent = "Open this bundle inside Anna to generate a summary.";
    return;
  }

  await anna.window.set_title({ title: "Text Summary" });
  status.textContent = "Ready to summarize.";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      status.className = "error";
      status.textContent = "Enter some text before generating a summary.";
      resultPanel.classList.add("hidden");
      return;
    }

    button.disabled = true;
    status.className = "";
    status.textContent = "Generating summary...";
    resultPanel.classList.add("hidden");
    try {
      const response = await anna.tools.invoke({
        tool_id: TOOL_ID,
        method: "summarize",
        args: { text },
        timeoutMs: 90000,
      });
      const summary =
        response?.data?.summary ??
        response?.result?.data?.summary ??
        response?.summary;
      if (!summary) throw new Error("The summarizer returned no summary.");
      result.textContent = summary;
      resultPanel.classList.remove("hidden");
      status.textContent = "Summary generated.";
      await anna.storage.set({ key: "summary:last", value: { text, summary } });
    } catch (e) {
      status.className = "error";
      status.textContent = "Error: " + (e.message || "Unable to generate summary.");
    } finally {
      button.disabled = false;
    }
  });
}

await main();

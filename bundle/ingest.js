const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_CHARS = 120000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "html", "htm",
  "log", "srt", "vtt", "py", "js", "ts", "jsx", "tsx", "java", "c", "h",
  "cpp", "hpp", "cs", "go", "rs", "rb", "php", "sql", "sh", "ps1", "css"
]);
const UNSUPPORTED_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "rtf", "odt", "epub",
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp3", "wav", "m4a", "mp4",
  "mov", "avi", "mkv", "exe", "dll", "com", "bat", "cmd"
]);

function extension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name || "");
  return match ? match[1].toLowerCase() : "";
}

function signature(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "executable";
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "container";
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "office-binary";
  return "text-or-unknown";
}

function decode(bytes) {
  let encoding = "utf-8";
  let warning = "";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = "utf-8";
  else {
    const sample = bytes.slice(0, Math.min(bytes.length, 4096));
    let validUtf8 = true;
    try { new TextDecoder("utf-8", { fatal: true }).decode(sample); }
    catch { validUtf8 = false; }
    if (sample.some(value => value === 0)) {
      warning = "The file contained binary-looking bytes; decoded text may be incomplete.";
    }
    if (!validUtf8 && sample.some(value => value >= 0x80)) {
      encoding = "windows-1252";
      warning = "Decoded using Windows-1252 compatibility encoding.";
    }
  }
  try {
    return { text: new TextDecoder(encoding, { fatal: false }).decode(bytes), encoding, warning };
  } catch (error) {
    console.error("StudyLens text decoding failed", error);
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      encoding: "utf-8",
      warning: "The original encoding was not recognized; replacement characters may appear."
    };
  }
}

function normalize(text, useNfkc = false) {
  const value = useNfkc ? text.normalize("NFKC") : text;
  return value.replace(/\0/g, "").replace(/[^\S\r\n\t]+/g, " ").replace(/[^\S\r\n\t]*\n[^\S\r\n\t]*/g, "\n").trim();
}

function csvOutline(text, separator) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === separator && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows[0] || [];
  const sampled = rows.slice(1, 101);
  return [
    `Table columns: ${header.join(" | ")}`,
    ...sampled.map((values, index) => `Row ${index + 1}: ${values.join(" | ")}`),
    rows.length > 101 ? `Sampled first 100 rows of ${rows.length - 1} data rows.` : ""
  ].filter(Boolean).join("\n");
}

function htmlText(text) {
  if (typeof DOMParser === "undefined") {
    return text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
  }
  const doc = new DOMParser().parseFromString(text, "text/html");
  doc.querySelectorAll("script,style,noscript,template").forEach(node => node.remove());
  return doc.body?.innerText || doc.documentElement?.textContent || "";
}

function structuredText(text, kind) {
  if (kind === "json") {
    try { return JSON.stringify(JSON.parse(text), null, 2); }
    catch { return text; }
  }
  if (kind === "xml") {
    if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return text;
    try { return new XMLSerializer().serializeToString(new DOMParser().parseFromString(text, "application/xml")); }
    catch { return text; }
  }
  return text;
}

function sourceMap(name, text, label = "text") {
  return [{ file: name, section: label, start: 0, end: text.length, snippet: text.slice(0, 240) }];
}

async function ingestOne(file, options) {
  const ext = extension(file.name);
  const base = { name: file.name || "pasted-file", size: file.size, type: file.type || "application/octet-stream", detectedKind: ext || "unknown", pages: [], sourceMap: [] };
  if (!file.size) return { ...base, status: "failed", text: "", warnings: ["This file is empty."] };
  if (file.size > MAX_FILE_BYTES) return { ...base, status: "unsupported", text: "", warnings: [`This file exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB per-file limit.`] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sig = signature(bytes);
  if (sig === "executable") return { ...base, detectedKind: "executable", status: "unsupported", text: "", warnings: ["Executable files are never opened or executed."] };
  if (sig === "pdf" || sig === "office-binary" || sig === "image" || UNSUPPORTED_EXTENSIONS.has(ext)) {
    const label = sig === "image" ? "Image OCR is not available in this offline environment." : sig === "pdf" ? "PDF parsing is not available in this offline environment." : "This document format needs a parser that is not installed in the Anna sandbox.";
    return { ...base, detectedKind: sig === "text-or-unknown" ? ext : sig, status: "unsupported", text: "", warnings: [label] };
  }
  if (sig === "zip") return { ...base, detectedKind: "zip", status: "unsupported", text: "", warnings: ["ZIP extraction requires a safe plugin-side transfer API, which is not available in the current bridge."] };
  const decoded = decode(bytes);
  let text = normalize(decoded.text, options.nfkc === true);
  let detectedKind = TEXT_EXTENSIONS.has(ext) ? ext : "text";
  if (ext === "csv") text = csvOutline(text, ",");
  else if (ext === "tsv") text = csvOutline(text, "\t");
  else if (ext === "json" || ext === "xml") text = structuredText(text, ext);
  else if (ext === "html" || ext === "htm") { text = normalize(htmlText(text)); detectedKind = "html"; }
  if (!text) return { ...base, detectedKind, status: "failed", text: "", warnings: ["No readable text was found."] };
  const warnings = decoded.warning ? [decoded.warning] : [];
  if (!TEXT_EXTENSIONS.has(ext) && ext) warnings.push(`The extension .${ext} was not recognized; treated as plain text.`);
  return { ...base, detectedKind, status: "ok", text: text.slice(0, MAX_TEXT_CHARS), warnings, sourceMap: sourceMap(file.name, text, detectedKind) };
}

export async function ingest(files, options = {}) {
  const list = Array.from(files || []);
  const total = list.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    return list.map(file => ({ name: file.name, size: file.size, type: file.type, detectedKind: extension(file.name) || "unknown", status: "unsupported", text: "", warnings: [`Combined files exceed the ${MAX_TOTAL_BYTES / 1024 / 1024} MB total limit.`], pages: [], sourceMap: [] }));
  }
  const results = [];
  for (const file of list) {
    try { results.push(await ingestOne(file, options)); }
    catch (error) {
      console.error("StudyLens ingestion failed", { name: file.name, error });
      results.push({ name: file.name, size: file.size, type: file.type, detectedKind: extension(file.name) || "unknown", status: "failed", text: "", warnings: ["This file could not be read safely."], pages: [], sourceMap: [] });
    }
  }
  return results;
}

export const INGEST_LIMITS = { maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxTextChars: MAX_TEXT_CHARS };

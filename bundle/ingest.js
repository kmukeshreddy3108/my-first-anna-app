const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_CHARS = 120000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "html", "htm",
  "log", "srt", "vtt", "py", "js", "ts", "jsx", "tsx", "java", "c", "h",
  "cpp", "hpp", "cs", "go", "rs", "rb", "php", "sql", "sh", "ps1", "css"
]);
const UNSUPPORTED_EXTENSIONS = new Set([
  "doc", "ppt", "xls", "rtf",
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp3", "wav", "m4a", "mp4",
  "mov", "avi", "mkv", "exe", "dll", "com", "bat", "cmd"
]);

const ZIP_LIMITS = { entries: 2000, uncompressedBytes: 80 * 1024 * 1024 };

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

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }
function zipNameSafe(name) { return name && !name.startsWith("/") && !name.split("/").includes(".."); }
async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("The document archive is corrupt or truncated.");
  const entries = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (entries > ZIP_LIMITS.entries || centralOffset + centralSize > bytes.length) throw new Error("The document archive is too large or uses unsupported ZIP64 metadata.");
  const result = new Map();
  let cursor = centralOffset;
  let total = 0;
  for (let i = 0; i < entries; i += 1) {
    if (i && i % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    if (u32(view, cursor) !== 0x02014b50) throw new Error("The document archive has an invalid directory.");
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const name = new TextDecoder("utf-8").decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (!zipNameSafe(name)) throw new Error("The archive contains an unsafe path.");
    if (flags & 1) throw new Error("Encrypted document archives are not supported.");
    if (uncompressedSize > ZIP_LIMITS.uncompressedBytes || total + uncompressedSize > ZIP_LIMITS.uncompressedBytes) throw new Error("The document archive is too large to process safely.");
    if (method !== 0 && method !== 8) throw new Error(`The archive uses unsupported compression for ${name}.`);
    const local = localOffset;
    if (u32(view, local) !== 0x04034b50) throw new Error("The document archive has an invalid file entry.");
    const localNameLength = u16(view, local + 26);
    const localExtraLength = u16(view, local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(start, start + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else data = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    if (data.byteLength !== uncompressedSize) throw new Error(`The archive entry ${name} is truncated.`);
    total += data.byteLength;
    result.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}
function xmlText(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("The document XML is invalid.");
  return doc;
}
function nodeText(node) { return (node?.textContent || "").replace(/\s+/g, " ").trim(); }
function ooxmlParagraphs(doc, sectionLabel) {
  const refs = [];
  let paragraph = 0;
  doc.querySelectorAll("w\\:p, p").forEach(node => {
    const text = nodeText(node);
    if (!text) return;
    paragraph += 1;
    const style = node.querySelector("w\\:pStyle, pStyle")?.getAttribute("w:val") || "";
    const bullet = node.querySelector("w\\:numPr, numPr") ? "• " : "";
    refs.push({ text: `${bullet}${text}`, source: { section: sectionLabel, paragraph, snippet: text } });
    if (style.toLowerCase().includes("heading")) refs[refs.length - 1].text = `${style}: ${refs[refs.length - 1].text}`;
  });
  doc.querySelectorAll("w\\:tbl, tbl").forEach((table, index) => {
    const rows = [...table.querySelectorAll("w\\:tr, tr")].map(row => [...row.querySelectorAll("w\\:tc, tc")].map(nodeText).join(" | ")).filter(Boolean);
    if (rows.length) refs.push({ text: `Table ${index + 1}:\n${rows.join("\n")}`, source: { section: sectionLabel, table: index + 1, snippet: rows[0] } });
  });
  return refs;
}
async function zipDocument(file, bytes, ext) {
  const entries = await readZip(bytes);
  const warnings = ["Images were skipped; text and tables were extracted locally."];
  let parts = [];
  if (ext === "docx") {
    const names = ["word/document.xml", "word/footnotes.xml", "word/header1.xml", "word/footer1.xml"];
    for (const name of names) if (entries.has(name)) parts.push(...ooxmlParagraphs(xmlText(new TextDecoder().decode(entries.get(name))), name));
  } else if (ext === "pptx") {
    const slides = [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    for (const name of slides) parts.push(...ooxmlParagraphs(xmlText(new TextDecoder().decode(entries.get(name))), name));
    for (const name of entries.keys()) if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)) parts.push(...ooxmlParagraphs(xmlText(new TextDecoder().decode(entries.get(name))), name));
  } else if (ext === "xlsx") {
    const shared = entries.has("xl/sharedStrings.xml") ? [...xmlText(new TextDecoder().decode(entries.get("xl/sharedStrings.xml"))).querySelectorAll("si")].map(nodeText) : [];
    const workbook = entries.has("xl/workbook.xml") ? xmlText(new TextDecoder().decode(entries.get("xl/workbook.xml"))) : null;
    const sheetNames = workbook ? [...workbook.querySelectorAll("sheet")].map(node => node.getAttribute("name")) : [];
    const sheets = [...entries.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
    sheets.forEach((name, index) => {
      const doc = xmlText(new TextDecoder().decode(entries.get(name)));
      const rows = [...doc.querySelectorAll("row")].slice(0, 200).map(row => [...row.querySelectorAll("c")].map(cell => {
        const value = nodeText(cell.querySelector("v"));
        return cell.getAttribute("t") === "s" ? shared[Number(value)] || "" : value;
      }).join(" | "));
      parts.push({ text: `Sheet ${sheetNames[index] || index + 1}:\n${rows.join("\n")}${doc.querySelectorAll("row").length > 200 ? "\nSampled first 200 rows." : ""}`, source: { section: sheetNames[index] || `Sheet ${index + 1}`, snippet: rows[0] || "" } });
    });
  } else if (ext === "odt") {
    const doc = xmlText(new TextDecoder().decode(entries.get("content.xml")));
    parts = [...doc.querySelectorAll("text\\:h, text\\:p, h, p")].map((node, index) => ({ text: nodeText(node), source: { section: "content.xml", paragraph: index + 1, snippet: nodeText(node) } })).filter(item => item.text);
  } else if (ext === "epub") {
    const container = entries.get("META-INF/container.xml");
    const root = container ? xmlText(new TextDecoder().decode(container)).querySelector("rootfile")?.getAttribute("full-path") : "";
    const opf = root && entries.has(root) ? xmlText(new TextDecoder().decode(entries.get(root))) : null;
    const base = root ? root.slice(0, root.lastIndexOf("/") + 1) : "";
    const manifest = new Map(opf ? [...opf.querySelectorAll("item")].map(item => [item.getAttribute("id"), item.getAttribute("href")]) : []);
    const spine = opf ? [...opf.querySelectorAll("itemref")].map(item => manifest.get(item.getAttribute("idref"))).filter(Boolean) : [];
    for (const href of spine) {
      const name = `${base}${decodeURIComponent(href)}`;
      if (!entries.has(name)) continue;
      const text = normalize(htmlText(new TextDecoder().decode(entries.get(name))));
      if (text) parts.push({ text, source: { section: name, snippet: text.slice(0, 240) } });
    }
  }
  const text = parts.map(item => item.text).join("\n\n").slice(0, MAX_TEXT_CHARS);
  if (!text) throw new Error("No readable text was found in this document.");
  return { ...file, detectedKind: ext, status: "ok", text, warnings, pages: [], sourceMap: parts.map(item => ({ file: file.name, ...item.source, start: 0, end: item.text.length })) };
}

async function ingestOne(file, options) {
  const ext = extension(file.name);
  const base = { name: file.name || "pasted-file", size: file.size, type: file.type || "application/octet-stream", detectedKind: ext || "unknown", pages: [], sourceMap: [] };
  if (!file.size) return { ...base, status: "failed", text: "", warnings: ["This file is empty."] };
  if (file.size > MAX_FILE_BYTES) return { ...base, status: "unsupported", text: "", warnings: [`This file exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB per-file limit.`] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sig = signature(bytes);
  if (sig === "executable") return { ...base, detectedKind: "executable", status: "unsupported", text: "", warnings: ["Executable files are never opened or executed."] };
  if (sig === "pdf" && typeof options.parsePdf === "function") {
    try {
      const parsed = await options.parsePdf(bytes, file);
      if (parsed?.status === "ok") return { ...base, ...parsed, name: file.name, size: file.size, type: file.type || base.type, detectedKind: "pdf" };
      return { ...base, ...parsed, name: file.name, size: file.size, type: file.type || base.type, detectedKind: "pdf", status: parsed?.status || "failed", text: parsed?.text || "", pages: parsed?.pages || [], sourceMap: parsed?.sourceMap || [], warnings: parsed?.warnings || ["This PDF could not be read."] };
    } catch (error) {
      console.error("StudyLens PDF parsing failed", error);
      return { ...base, detectedKind: "pdf", status: "failed", text: "", warnings: ["This PDF could not be read. Try a text-based PDF or a smaller file."] };
    }
  }
  if (sig === "pdf") return { ...base, detectedKind: "pdf", status: "unsupported", text: "", warnings: ["PDF parsing requires the Anna plugin bridge. If the bridge is unavailable, use a text-based document or reconnect."] };
  if (sig === "office-binary" || sig === "image" || UNSUPPORTED_EXTENSIONS.has(ext)) {
    const label = sig === "image" ? "Image OCR is not available in this offline environment." : "This legacy or binary format is not supported. Try DOCX, PPTX, XLSX, ODT, EPUB, or PDF.";
    return { ...base, detectedKind: sig === "text-or-unknown" ? ext : sig, status: "unsupported", text: "", warnings: [label] };
  }
  if (sig === "zip" && ["docx", "pptx", "xlsx", "odt", "epub"].includes(ext)) {
    try { return await zipDocument(base, bytes, ext); }
    catch (error) { console.error("StudyLens archive parsing failed", error); return { ...base, detectedKind: ext, status: "failed", text: "", warnings: [error.message || "This document archive could not be read safely."] }; }
  }
  if (sig === "zip") return { ...base, detectedKind: "zip", status: "unsupported", text: "", warnings: ["This ZIP archive is not a supported document format."] };
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
  const existingBytes = Number.isFinite(options.existingBytes) ? Math.max(0, options.existingBytes) : 0;
  const total = existingBytes + list.reduce((sum, file) => sum + file.size, 0);
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

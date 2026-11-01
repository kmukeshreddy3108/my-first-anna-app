import { readFile } from "node:fs/promises";
import { ingest } from "../bundle/ingest.js";

const root = new URL("../fixtures/", import.meta.url);
const paths = ["unicode.txt", "quoted.csv", "data.json", "page.html", "document.xml"];
const utf16Text = "UTF-16 text contains enough readable content.";
const utf16Bytes = Uint8Array.from([0xff, 0xfe, ...Array.from(utf16Text).flatMap(char => [char.charCodeAt(0), 0])]);
const cases = [
  ...paths.map(name => ({ name, expected: "ok" })),
  { name: "cp1252.txt", bytes: Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x6e, 0x6f, 0x74, 0x65]), expected: "ok" },
  { name: "utf16.txt", bytes: utf16Bytes, expected: "ok" },
  { name: "large.csv", bytes: new TextEncoder().encode(`name,value\n${Array.from({ length: 10000 }, (_, i) => `row-${i},${i}`).join("\n")}`), expected: "ok" },
  { name: "empty.txt", bytes: new Uint8Array(), expected: "failed" },
  { name: "renamed.exe.txt", bytes: Uint8Array.from([0x4d, 0x5a, 0x90, 0]), expected: "unsupported" },
  { name: "scan.pdf", bytes: new TextEncoder().encode("%PDF-1.7"), expected: "unsupported" },
  { name: "image.png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), expected: "unsupported" },
  { name: "book.epub", bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), expected: "unsupported" },
];

const files = [];
for (const item of cases) {
  const bytes = item.bytes || await readFile(new URL(item.name, root));
  files.push({ name: item.name, size: bytes.byteLength, type: "", async arrayBuffer() { return bytes; } });
}
const results = await ingest(files);
console.log("fixture | expected | actual | result");
console.log("-----------------------------------------");
let failures = 0;
for (const [index, item] of cases.entries()) {
  const actual = results[index].status;
  const pass = actual === item.expected;
  if (!pass) failures += 1;
  console.log(`${item.name} | ${item.expected} | ${actual} | ${pass ? "PASS" : "FAIL"}`);
}
if (failures) process.exitCode = 1;
else console.log(`TOTAL PASS=${cases.length}`);

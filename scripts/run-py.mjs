import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const winPy = resolve("executas/my-first-anna-app/.venv/Scripts/python.exe");
const unixPy = resolve("executas/my-first-anna-app/.venv/bin/python");
const py = existsSync(winPy) ? winPy : (existsSync(unixPy) ? unixPy : "python");

const [,, ...args] = process.argv;
const child = spawn(py, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

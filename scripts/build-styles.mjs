// Builds web/src/styles.css from web/src/styles.src.css: the dark token block is written once in the
// source and stamped into both dark selectors (OS setting and the manual toggle), so they never drift.
import fs from "node:fs";
const src = fs.readFileSync("web/src/styles.src.css", "utf8");
const m = src.match(/\/\*@@DARK@@\n([\s\S]*?)@@DARK@@\*\//);
if (!m) throw new Error("dark block marker missing");
const body = m[1].trimEnd();
const dark = `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${body.replace(/^ {4}/gm, "    ")}\n  }\n}\n:root[data-theme="dark"] {\n${body.replace(/^ {4}/gm, "  ")}\n}`;
const out = "/* GENERATED from styles.src.css by scripts/build-styles.mjs — edit the source. */\n" + src.replace(m[0], dark);
fs.writeFileSync("web/src/styles.css", out);
console.log("styles.css written", out.split("\n").length, "lines");

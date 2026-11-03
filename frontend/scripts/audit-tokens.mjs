/* global process, console */
// Finds design values written outside the token definitions: colours, font sizes and
// spacing (padding / margin / gap / inset) in the stylesheet partials (src/styles.css and
// src/styles/**; tokens.css is where tokens are defined, so it is skipped), and inline
// style={{ … }} values in JSX. Usage: node scripts/audit-tokens.mjs [--list]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const list = process.argv.includes("--list");
function cssFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? cssFiles(p) : p.endsWith(".css") ? [p] : [];
  });
}
const sheets = ["src/styles.css", ...cssFiles("src/styles")]
  .filter((p) => !/tokens\.css$/.test(p))
  .map((p) => [p.split("\\").join("/").replace(/^src\//, ""), readFileSync(p, "utf8")]);

// Theme blocks (`:root {`, `:root[data-theme…] {`, and the dark media query) are where
// tokens are defined; everything else must use var(--…).
function stripTokenBlocks(text) {
  const out = [];
  let i = 0;
  const lines = text.split("\n");
  let depth = 0;
  let inToken = false;
  let tokenDepth = 0;
  for (const line of lines) {
    i += 1;
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;
    if (!inToken && /^\s*(:root[^{]*|@media \(prefers-color-scheme: dark\))\s*{/.test(line)) {
      inToken = true;
      tokenDepth = depth;
    }
    if (!inToken) out.push([i, line]);
    depth += opens - closes;
    if (inToken && depth <= tokenDepth) inToken = false;
  }
  return out;
}

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const FONT_SIZE = /font-size:\s*([^;]+);/;
const SPACING = /^\s*(padding|margin|gap|row-gap|column-gap|top|right|bottom|left|inset)(-[a-z]+)?:\s*([^;]+);/;
// Allowed literal values that aren't design decisions.
const SPACING_OK = /^(0|auto|-?100%|50%|inherit|initial|unset|none)$/;

const findings = { color: [], fontSize: [], spacing: [] };
for (const [file, css] of sheets) for (const [n, line] of stripTokenBlocks(css)) {
  if (/^\s*(\/\*|\*)/.test(line)) continue;
  for (const m of line.match(COLOR) || []) findings.color.push(`${file}:${n}  ${m}`);
  const fs = line.match(FONT_SIZE);
  if (fs && !/var\(--/.test(fs[1]) && !/^(inherit|1em|100%)$/.test(fs[1].trim())) {
    findings.fontSize.push(`${file}:${n}  ${fs[1].trim()}`);
  }
  const sp = line.match(SPACING);
  if (sp) {
    // A literal length (px / rem) left after removing token references is a hard-coded
    // value; percentages, em-relative lengths and zeros are not design values.
    const parts = sp[3].replace(/var\([^)]*\)/g, "").split(/[\s(),*/+]+/).filter(Boolean);
    const bad = parts.filter((p) => /^-?\d+(\.\d+)?(px|rem)$/.test(p) && !/^-?0(px)?$/.test(p) && !SPACING_OK.test(p));
    if (bad.length) findings.spacing.push(`${file}:${n}  ${sp[1]}${sp[2] ?? ""}: ${sp[3].trim()}`);
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".jsx") ? [p] : [];
  });
}
const inline = [];
for (const file of walk("src")) {
  readFileSync(file, "utf8").split("\n").forEach((line, idx) => {
    // Data-driven values (custom properties, computed positions) are fine; literal
    // spacing, sizes and colours are design decisions that belong in CSS.
    if (/style=\{\{/.test(line) &&
        /(margin|padding|gap|fontSize|minHeight|maxHeight|width|height)\w*:\s*["'\d]|#[0-9a-f]{3,6}/i.test(line) &&
        !/\$\{|`/.test(line)) {
      inline.push(`${file}:${idx + 1}  ${line.trim()}`);
    }
  });
}

const counts = {
  colors: findings.color.length,
  fontSizes: findings.fontSize.length,
  spacing: findings.spacing.length,
  inlineStyles: inline.length,
};
console.log(JSON.stringify(counts));
if (list) {
  for (const [k, v] of Object.entries({ ...findings, inline })) {
    console.log(`\n## ${k}`);
    for (const x of v) console.log(x);
  }
}
process.exitCode = Object.values(counts).some((c) => c > 0) ? 1 : 0;

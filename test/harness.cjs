// node test/harness.cjs <vault> <out dir>: writes a page that runs the real plugin in a browser on a
// copy of the notes it needs, with Obsidian's API stubbed. The copy holds private notes, so keep the
// out dir outside this repo. Open it with ?tab=, ?theme=, ?run=1 (runs the checks into #result).
const fs = require("fs");
const path = require("path");
const [vault, out] = process.argv.slice(2);
const root = path.join(__dirname, "..");
const walk = (dir, rel = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const r = rel ? `${rel}/${e.name}` : e.name;
  if (e.name.startsWith(".")) return [];
  return e.isDirectory() ? walk(path.join(dir, e.name), r) : r.endsWith(".md") ? [r] : [];
});
const notes = {};
for (const f of walk(vault)) {
  if (f.startsWith("1 AgentHub/") || f.startsWith("0 Home/5 AgentHub/")) continue;
  const text = fs.readFileSync(path.join(vault, f), "utf8");
  const mtime = fs.statSync(path.join(vault, f)).mtimeMs;
  if (/^\s*- \[[ xX]\] /m.test(text) || /Schedule\/|Tasks\/(Inbox|Email)\.md$/.test(f)) notes[f] = { text, mtime };
  else notes[f] = { text: "", mtime };
}
const stub = fs.readFileSync(path.join(__dirname, "stub.js"), "utf8");
const html = `<!doctype html><meta charset="utf-8"><title>Planner test</title>
<style>${fs.readFileSync(path.join(__dirname, "obsidian-defaults.css"), "utf8")}</style>
<style>${fs.readFileSync(path.join(root, "styles.css"), "utf8")}</style>
<div id="pane" class="view-content"></div><pre id="result"></pre>
<script>const NOTES = ${JSON.stringify(notes).replace(/</g, "\\u003c")};</script>
<script>${stub}</script>
<script>(function (module, require) {${fs.readFileSync(path.join(root, "main.js"), "utf8").replace(/<\/script/g, "<\\/script")}\n})(module, require);</script>
<script>${fs.readFileSync(path.join(__dirname, "checks.js"), "utf8")}</script>`;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), html);
console.log("wrote", path.join(out, "index.html"), Object.keys(notes).length, "notes");

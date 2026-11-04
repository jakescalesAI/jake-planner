// The Planner as a phone loads it: no Node at all, only obsidian to require, and a vault mid-sync.
// usage: node test/mobile.test.cjs        (exit code 1 if anything fails)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
class TFile { constructor(p) { this.path = p; this.stat = { mtime: 1 }; } }

function phone(notes, broken = []) {
  const events = [];
  const files = Object.keys(notes).map((p) => new TFile(p));
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (p) => files.find((f) => f.path === p) || null,
      cachedRead: async (f) => { if (broken.includes(f.path)) throw new Error("ENOENT: the note went away mid-sync"); return notes[f.path]; },
      on: (kind) => { events.push(kind); return {}; },
    },
    metadataCache: { getFileCache: () => null, on: (kind) => { events.push(kind); return {}; }, offref() {} },
    workspace: { onLayoutReady(fn) { this.ready = fn(); }, getLeavesOfType: () => [] },
  };
  const asked = [];
  const box = {
    module: { exports: {} }, console: { log() {}, error() {} }, setTimeout, clearTimeout, Intl, Date,
    window: { setInterval: () => 1, localStorage: { getItem: () => null, setItem() {} } },
    require: (n) => {
      asked.push(n);
      if (n !== "obsidian") throw new Error("Node module on mobile: " + n);
      return { TFile, Platform: { isMobile: true, isPhone: true }, Notice: class {}, ItemView: class {}, Plugin: class { constructor() { this.app = app; } registerView() {} addRibbonIcon() {} addCommand() {} registerEvent() {} registerInterval() {} } };
    },
  };
  vm.runInContext(src, vm.createContext(box));
  return { Plugin: box.module.exports, app, asked, events, box };
}

const tests = [
  ["the manifest allows phones", async () => assert.strictEqual(manifest.isDesktopOnly, false)],
  ["the source names nothing a phone lacks", async () => {
    assert.deepStrictEqual(src.match(/\b(process\.|Buffer\.|__dirname|electron|getBasePath|child_process)\b/g), null);
  }],
  ["it loads with only obsidian required", async () => {
    const p = phone({ "a.md": "- [ ] One\n" });
    assert.strictEqual(typeof p.box.process, "undefined");
    assert.strictEqual(typeof p.box.Buffer, "undefined");
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    assert.strictEqual(p.asked.join(), "obsidian");
    assert.strictEqual(plugin.store.tasks.length, 1);
    assert.ok(plugin.store.ready);
  }],
  ["one unreadable note doesn't stop the Planner", async () => {
    const p = phone({ "a.md": "- [ ] One\n", "gone.md": "- [ ] Two\n", "b.md": "- [ ] Three\n" }, ["gone.md"]);
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    assert.ok(plugin.store.ready, "stuck on loading");
    assert.strictEqual(plugin.store.tasks.map((t) => t.title).sort().join(), "One,Three");
    for (const kind of ["modify", "create", "delete", "rename", "resolved"]) assert.ok(p.events.includes(kind), `no ${kind} listener, so it would never update`);
  }],
  ["a calendar note that can't be read doesn't stop it either", async () => {
    const cal = "0 Home/3 Schedule/Calendar.md";
    const p = phone({ "a.md": "- [ ] One\n", [cal]: "x" }, [cal]);
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    assert.ok(plugin.store.ready, "stuck on loading");
    assert.strictEqual(plugin.store.tasks.length, 1);
  }],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.log("NOT OK -", name, "  ", e.message.split("\n")[0]); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

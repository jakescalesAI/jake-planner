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
  ["a task in 10 Money is never read or listed", async () => {
    const money = "10 Money/Bank/statement.md";
    const p = phone({ "a.md": "- [ ] One\n", [money]: "- [ ] Pay the bank\n" });
    const reads = [];
    const read = p.app.vault.cachedRead;
    p.app.vault.cachedRead = (f) => { reads.push(f.path); return read(f); };
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    plugin.store.changed(p.app.vault.getAbstractFileByPath(money));
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(!reads.includes(money), "the note was read");
    assert.strictEqual(plugin.store.tasks.map((t) => t.title).join(), "One");
  }],
  ["10 Money is private at any depth and in any case", async () => {
    const hidden = ["10 Money/a.md", "10 money/a.md", "10 MONEY/x/a.md", "0 Home/10 Money/a.md", "2 Thoughts/deep/10 money/b/a.md", "0 Home/ 10 Money /a.md"];
    const notes = { "a.md": "- [ ] One\n", "10 Moneyish/a.md": "- [ ] Two\n", "x10 Money/a.md": "- [ ] Three\n" };
    for (const h of hidden) notes[h] = "- [ ] Private\n";
    const p = phone(notes);
    const reads = [];
    const read = p.app.vault.cachedRead;
    p.app.vault.cachedRead = (f) => { reads.push(f.path); return read(f); };
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    assert.deepStrictEqual(reads.filter((r) => hidden.includes(r)), []);
    assert.strictEqual(plugin.store.tasks.map((t) => t.title).sort().join(), "One,Three,Two");
    plugin.store.changed(p.app.vault.getAbstractFileByPath("0 Home/10 Money/a.md"));
    await new Promise((r) => setTimeout(r, 250));
    assert.deepStrictEqual(reads.filter((r) => hidden.includes(r)), []);
  }],
  ["a note moved into 10 Money within the debounce isn't read", async () => {
    const p = phone({ "a.md": "- [ ] One\n", "b.md": "- [ ] Moved\n" });
    const reads = [];
    const read = p.app.vault.cachedRead;
    p.app.vault.cachedRead = (f) => { reads.push(f.path); return read(f); };
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    reads.length = 0;
    const file = p.app.vault.getAbstractFileByPath("b.md");
    plugin.store.changed(file);
    file.path = "10 Money/b.md";  // Obsidian moves the same TFile, so the queued re-read sees the new path
    await new Promise((r) => setTimeout(r, 250));
    assert.deepStrictEqual(reads, []);
    assert.strictEqual(plugin.store.byPath.has("10 Money/b.md"), false);
  }],
  ["the queued re-read is cancelled when the note goes", async () => {
    const p = phone({ "a.md": "- [ ] One\n", "b.md": "- [ ] Gone\n" });
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    plugin.store.changed(p.app.vault.getAbstractFileByPath("b.md"));
    assert.strictEqual(plugin.store.timers.size, 1);
    plugin.store.removed("b.md");
    assert.strictEqual(plugin.store.timers.size, 0);
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(plugin.store.tasks.map((t) => t.title).join(), "One");
  }],
  ["a note moved into 10 Money during the read is dropped", async () => {
    const p = phone({ "a.md": "- [ ] One\n", "b.md": "- [ ] Moved\n" });
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    const file = p.app.vault.getAbstractFileByPath("b.md");
    const read = p.app.vault.cachedRead;
    p.app.vault.cachedRead = async (f) => { const text = await read(f); f.path = "10 Money/b.md"; return text; };
    await plugin.store.readFile(file);
    assert.strictEqual(plugin.store.byPath.has("10 Money/b.md"), false);
  }],
  ["the move itself drops the note's tasks", async () => {
    const p = phone({ "a.md": "- [ ] One\n", "b.md": "- [ ] Moved\n" });
    const handlers = {};
    p.app.vault.on = (kind, fn) => { handlers[kind] = fn; return {}; };
    const plugin = new p.Plugin();
    await plugin.onload();
    await p.app.workspace.ready;
    const file = p.app.vault.getAbstractFileByPath("b.md");
    handlers.modify(file);
    file.path = "0 Home/10 Money/b.md";
    handlers.rename(file, "b.md");
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(plugin.store.tasks.map((t) => t.title).join(), "One");
    assert.strictEqual(plugin.store.timers.size, 0);
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

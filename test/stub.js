// Just enough of Obsidian's API to run the plugin, on an in-memory vault that records nothing to disk.
const module = { exports: {} };
class TFile { constructor(path, mtime) { this.path = path; this.stat = { mtime }; } }
const handlers = { modify: [], create: [], delete: [], rename: [], resolved: [] };
const files = new Map(Object.entries(NOTES).map(([p, n]) => [p, new TFile(p, n.mtime)]));
const texts = new Map(Object.entries(NOTES).map(([p, n]) => [p, n.text]));
const notices = [];
const on = (kind, fn) => { handlers[kind].push(fn); return fn; };
const vault = {
  getMarkdownFiles: () => [...files.values()],
  getAbstractFileByPath: (p) => files.get(p) || null,
  cachedRead: async (f) => texts.get(f.path),
  process: async (f, fn) => { const out = fn(texts.get(f.path)); texts.set(f.path, out); handlers.modify.forEach((h) => h(f)); return out; },
  on,
};
const metadataCache = {
  getFileCache: (f) => ({ listItems: /^\s*- \[[ xX]\] /m.test(texts.get(f.path)) ? [{ task: " " }] : [] }),
  on, offref: () => {},
};
const opened = [];
const pluginLeaf = { view: null, setViewState: async () => {} };
const workspace = {
  onLayoutReady: (fn) => fn(), getLeavesOfType: () => [pluginLeaf], revealLeaf: async () => {},
  getRightLeaf: () => pluginLeaf, getLeaf: () => ({ openFile: async (f, o) => opened.push([f.path, o.eState.line]) }),
};
const app = { vault, metadataCache, workspace };
class Plugin {
  constructor() { this.app = app; }
  registerView(type, make) { this.make = make; }
  addRibbonIcon() {} addCommand() {} registerEvent() {} registerInterval() {}
}
class ItemView { constructor(leaf) { this.leaf = leaf; this.app = app; this.contentEl = document.getElementById("pane"); } }
class Notice { constructor(t) { notices.push(t); } }
const require = (name) => { if (name !== "obsidian") throw new Error(name); return { Plugin, ItemView, Notice, Platform: { isPhone: innerWidth < 500 }, TFile }; };
// Stands in for a sync landing from another device.
function syncIn(path, text) {
  texts.set(path, text);
  if (!files.has(path)) { files.set(path, new TFile(path, Date.now())); handlers.create.forEach((h) => h(files.get(path))); }
  else handlers.modify.forEach((h) => h(files.get(path)));
}

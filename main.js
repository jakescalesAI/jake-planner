/* Planner: Jake's calendar and tasks in one view.
   The notes stay the source of truth. Calendar.md (calsync) and task checkboxes anywhere in the
   vault are read live; ticking writes the same "- [x] ... ✅ date" line the scheduler already
   reads, new tasks go to Inbox.md, new events go to Add to calendar.md. No Node APIs, so it runs
   on the phone and iPad too. Styled after Vault Claude (Apple's HIG); see styles.css. */
const { Plugin, ItemView, Notice, Platform, TFile } = require("obsidian");

const VIEW_TYPE = "jake-planner-view";
const CALENDAR_NOTE = "0 Home/3 Schedule/Calendar.md";
const ADD_EVENT_NOTE = "0 Home/3 Schedule/Add to calendar.md";
const INBOX_NOTE = "0 Home/2 Tasks/Inbox.md";
const EMAIL_NOTE = "0 Home/2 Tasks/Email.md";
const CALENDAR_DAYS = 14;
// Same exclusions as the task queries on Home and the rule in the vault's CLAUDE.md.
const EXCLUDED = ["0 Home/5 AgentHub/", "1 AgentHub/", "7 Scraper/", "0 Home/0 Quartzi Copilot/", "0 Home/4 Templates/", "0 Home/2 Tasks/README.md"];
const LANES = ["Work", "Health", "Videos", "Writing", "School", "Campus Citizen"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ---------- dates ---------- */
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = fromIso(iso); d.setDate(d.getDate() + n); return isoDate(d); };
const shortDate = (iso) => { const d = fromIso(iso); return `${WEEKDAYS[d.getDay()].slice(0, 3)}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };
const longDate = (iso) => { const d = fromIso(iso); return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const minutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const clock = (mins) => {
  const h = Math.floor(mins / 60) % 24;
  return `${h % 12 || 12}:${pad(mins % 60)} ${h < 12 ? "AM" : "PM"}`;
};

/* ---------- task lines ---------- */
const TASK_LINE = /^(\s*)- \[([ xX])\] (.*)$/;
const FIELD = /\[([A-Za-z_]+):: ([^\]]*)\]/g;
const DATED = /([📅⏳✅🛫➕❌])\s*(\d{4}-\d{2}-\d{2})/gu;

function plainTitle(text) {
  return text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Everything the row shows comes out of the text after the checkbox; the line itself is never rebuilt.
function parseBody(body) {
  const out = { fields: {}, deadline: "", doneDate: "" };
  for (const m of body.matchAll(FIELD)) if (!(m[1] in out.fields)) out.fields[m[1]] = m[2].trim();
  for (const m of body.matchAll(DATED)) {
    if (m[1] === "📅") out.deadline = m[2];
    if (m[1] === "✅") out.doneDate = m[2];
  }
  let title = body.replace(FIELD, " ").replace(DATED, " ").replace(/#fixed\b/g, " ");
  const source = title.match(/\(from ([^)]*)\)\s*$/);
  if (source) title = title.slice(0, source.index);
  out.title = plainTitle(title);
  out.source = source ? source[1].trim() : "";
  out.fixed = /#fixed\b/.test(body);
  return out;
}

function parseTask(line, path, lineNo) {
  const m = line.replace(/\r$/, "").match(TASK_LINE);
  if (!m) return null;
  return Object.assign(parseBody(m[3]), { path, line: lineNo, raw: line, done: m[2] !== " " });
}

// Checkboxes in code fences are examples, not tasks.
function parseNote(text, path) {
  const tasks = [];
  let fence = null;
  text.split("\n").forEach((line, i) => {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const task = parseTask(line, path, i);
    if (task) tasks.push(task);
  });
  return tasks;
}

// Email.md: plain "- " bullets are suggestions nothing has booked yet.
function parseEmail(text) {
  const items = [];
  text.split("\n").forEach((line, i) => {
    const m = line.replace(/\r$/, "").match(/^- (?!\[[ xX]\] )(.+)$/);
    if (m) items.push(Object.assign(parseBody(m[1]), { path: EMAIL_NOTE, line: i, raw: line }));
  });
  return items;
}

function tickLine(line, today) {
  const body = line.trimEnd();
  const tail = line.slice(body.length);
  return `${body.replace(/^(\s*- \[) \]/, "$1x]")} ✅ ${today}${tail}`;
}
const untickLine = (line) => line.replace(/^(\s*- \[)[xX]\]/, "$1 ]").replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/u, "");
const bookLine = (line) => line.replace(/^- /, "- [ ] ");

// A line moves when a note is edited, so check it is still the same text before touching it.
function replaceLine(data, item, change) {
  const lines = data.split("\n");
  let i = lines[item.line] === item.raw ? item.line : -1;
  if (i < 0) {
    const found = lines.reduce((acc, l, n) => (l === item.raw ? acc.concat(n) : acc), []);
    if (found.length !== 1) throw new Error("That line changed in the note. Try again.");
    i = found[0];
  }
  lines[i] = change(lines[i]);
  return lines.join("\n");
}

function newTaskLine(text, deadline) {
  const clean = text.replace(/\s+/g, " ").trim().replace(/^- (\[[ xX]\] )?/, "");
  return `- [ ] ${clean}${deadline ? ` 📅 ${deadline}` : ""}`;
}
const appendLine = (data, line) => `${data.replace(/\s*$/, "")}\n${line}\n`;

// New events go at the end of the "## Events" section, which calsync reads every two minutes.
function appendEvent(data, text) {
  const line = `- ${text.replace(/\s+/g, " ").trim().replace(/^- /, "")}`;
  const lines = data.split("\n");
  const start = lines.findIndex((l) => /^## Events\s*$/.test(l));
  if (start < 0) return appendLine(`${data.replace(/\s*$/, "")}\n\n## Events\n`, line);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, line);
  return lines.join("\n").replace(/\s*$/, "\n");
}

/* ---------- Calendar.md ---------- */
// calsync writes "## Today · Monday, November 2" with no year: take the nearest year.
function headingDate(text, now) {
  const m = text.match(/([A-Z][a-z]+), ([A-Z][a-z]+) (\d{1,2})\s*$/);
  if (!m) return "";
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return "";
  let best = "";
  let bestGap = Infinity;
  for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const d = new Date(y, month, Number(m[3]));
    const gap = Math.abs(d - now);
    if (gap < bestGap) { best = isoDate(d); bestGap = gap; }
  }
  return best;
}

function parseSpan(span) {
  const m = span.match(/^(\d{1,2})(?::(\d{2}))?(?:\s*([AP]M))?\s*[–-]\s*(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/);
  if (!m) return null;
  const to24 = (h, ap) => (Number(h) % 12) + (ap === "PM" ? 12 : 0);
  const startMin = to24(m[1], m[3] || m[6]) * 60 + Number(m[2] || 0);
  let endMin = to24(m[4], m[6]) * 60 + Number(m[5] || 0);
  if (endMin <= startMin) endMin += 24 * 60; // runs past midnight
  return { startMin, endMin };
}

function parseCalendar(text, now) {
  const days = new Map();
  let day = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("## ")) {
      day = headingDate(line.slice(3), now);
      if (day && !days.has(day)) days.set(day, []);
      continue;
    }
    if (!day || !line.startsWith("- ")) continue;
    const at = line.indexOf(" · ");
    if (at < 0) continue;
    const when = line.slice(2, at).trim();
    const title = line.slice(at + 3).trim();
    const workBlock = title.toLowerCase() === "work block";
    if (when === "All day") days.get(day).push({ allDay: true, title, workBlock, date: day });
    else {
      const span = parseSpan(when);
      if (span) days.get(day).push(Object.assign({ allDay: false, title, workBlock, date: day }, span));
    }
  }
  return days;
}

/* ---------- what goes where ---------- */
function bucketTasks(tasks, now) {
  const today = isoDate(now);
  const weekAgo = addDays(today, -7);
  const out = { overdue: [], today: [], upcoming: [], someday: [], done: [] };
  for (const t of tasks) {
    if (t.done) {
      if (t.doneDate >= weekAgo) out.done.push(t);
    } else if (t.deadline && t.deadline < today) out.overdue.push(t);
    else if (t.deadline === today) out.today.push(t);
    else if (t.deadline) out.upcoming.push(t);
    else out.someday.push(t);
  }
  const byDate = (a, b) => a.deadline.localeCompare(b.deadline) || a.title.localeCompare(b.title);
  out.overdue.sort(byDate);
  out.today.sort(byDate);
  out.upcoming.sort(byDate);
  out.done.sort((a, b) => b.doneDate.localeCompare(a.doneDate) || a.title.localeCompare(b.title));
  return out;
}

// One day's rows: Calendar.md first, then what's due. A task never holds time, so it never gets a timed row.
function dayAgenda(iso, calendar, tasks) {
  const allDay = [];
  const timed = [];
  for (const ev of calendar.get(iso) || []) {
    if (ev.allDay) allDay.push({ title: ev.title, workBlock: ev.workBlock });
    else timed.push({ title: ev.title, workBlock: ev.workBlock, startMin: ev.startMin, endMin: ev.endMin });
  }
  timed.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const due = tasks
    .filter((t) => t.deadline === iso && (!t.done || t.doneDate === iso))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { allDay, timed, due };
}

function taskCaption(task, now) {
  const today = isoDate(now);
  const bits = [];
  if (task.done) bits.push(task.doneDate ? `Done ${shortDate(task.doneDate)}` : "Done");
  else {
    if (task.deadline) {
      const time = task.fields.due_time ? ` at ${task.fields.due_time}` : "";
      if (task.deadline < today) bits.push(`Was due ${shortDate(task.deadline)}${time}`);
      else if (task.deadline === today) bits.push(`Due today${time}`);
      else if (task.deadline === addDays(today, 1)) bits.push(`Due tomorrow${time}`);
      else bits.push(`Due ${shortDate(task.deadline)}${time}`);
    }
    if (task.fields.atrisk) bits.push("At risk");
  }
  if (task.fields.est) bits.push(task.fields.est);
  if (task.fields.lane) bits.push(task.fields.lane);
  return bits.join(" · ");
}

/* ---------- the live index of the vault ---------- */
// The same rule as Quartzi Copilot: a folder of that name, in any case, at any depth.
const isPrivate = (path) => path.split("/").some((p) => p.trim().toLowerCase() === "10 money");
const inScope = (path) => path.endsWith(".md") && !isPrivate(path) && !EXCLUDED.some((p) => path.startsWith(p));

class Store {
  constructor(app) {
    this.app = app;
    this.byPath = new Map();
    this.calendar = new Map();
    this.calendarTime = 0;
    this.email = [];
    this.listeners = new Set();
    this.ready = false;
    this.timers = new Map();
  }

  get tasks() {
    return [...this.byPath.values()].flat();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.listeners.forEach((fn) => fn());
  }

  // The metadata cache says which notes have checkboxes, so opening on a phone doesn't read 1,500 files.
  async loadAll() {
    const files = this.app.vault.getMarkdownFiles().filter((f) => inScope(f.path));
    const worthReading = files.filter((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      return !cache || (cache.listItems || []).some((li) => li.task !== undefined) || f.path === EMAIL_NOTE;
    });
    this.byPath.clear();
    // A note can vanish between the listing and the read while a sync lands; the rest still load.
    const read = (f) => this.readFile(f).catch((e) => console.error("Planner: could not read", f.path, e));
    await Promise.all(worthReading.map(read));
    const cal = this.app.vault.getAbstractFileByPath(CALENDAR_NOTE);
    if (cal instanceof TFile) await read(cal);
    this.ready = true;
    this.emit();
  }

  async readFile(file) {
    // A note can move out of scope between being queued and being read, or during the read.
    if (!inScope(file.path)) return this.forget(file.path);
    const text = await this.app.vault.cachedRead(file);
    if (!inScope(file.path)) return this.forget(file.path);
    if (file.path === CALENDAR_NOTE) {
      this.calendar = parseCalendar(text, new Date());
      this.calendarTime = file.stat ? file.stat.mtime : 0;
    }
    if (file.path === EMAIL_NOTE) this.email = parseEmail(text);
    const tasks = parseNote(text, file.path);
    if (tasks.length) this.byPath.set(file.path, tasks);
    else this.byPath.delete(file.path);
  }

  forget(path) {
    this.byPath.delete(path);
    if (path === CALENDAR_NOTE) this.calendar = new Map();
    if (path === EMAIL_NOTE) this.email = [];
  }

  // A burst of edits to one note, or a sync landing, becomes one re-read and one redraw.
  changed(file) {
    if (!(file instanceof TFile) || !inScope(file.path)) return;
    clearTimeout(this.timers.get(file.path));
    this.timers.set(file.path, setTimeout(async () => {
      this.timers.delete(file.path);
      try {
        await this.readFile(file);
        this.emit();
      } catch (e) {
        console.error("Planner: could not read", file.path, e);
      }
    }, 200));
  }

  removed(path) {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.forget(path);
    this.emit();
  }

  file(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new Error(`${path} is missing.`);
    return f;
  }

  async edit(path, fn) {
    const f = this.file(path);
    await this.app.vault.process(f, fn);
    await this.readFile(f);
    this.emit();
  }

  setDone(task, done) {
    const today = isoDate(new Date());
    return this.edit(task.path, (data) => replaceLine(data, task, (l) => (done ? tickLine(l, today) : untickLine(l))));
  }

  book(item) {
    return this.edit(item.path, (data) => replaceLine(data, item, bookLine));
  }

  addTask(text, deadline) {
    return this.edit(INBOX_NOTE, (data) => appendLine(data, newTaskLine(text, deadline)));
  }

  addEvent(text) {
    return this.edit(ADD_EVENT_NOTE, (data) => appendEvent(data, text));
  }
}

/* ---------- the view ---------- */
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  next: '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  up: '<path d="M12 19V6M6 12l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M6.5 12.5l3.6 3.6 7.4-8.2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  open: '<path d="M9 6H6.5A1.5 1.5 0 0 0 5 7.5v10A1.5 1.5 0 0 0 6.5 19h10a1.5 1.5 0 0 0 1.5-1.5V15M13 5h6v6M19 5l-8 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  date: '<rect x="4" y="5.5" width="16" height="14.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 10.5h16M8.5 3.5v4M15.5 3.5v4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  close: '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
};

function el(tag, cls, text, parent) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

function icon(name, cls, parent) {
  const node = el("span", `jp-ico ${cls || ""}`.trim(), null, parent);
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return node;
}

function button(cls, label, parent, onClick) {
  const b = el("button", cls, null, parent);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

function memo(key, fallback) {
  try { return window.localStorage.getItem(`jake-planner-${key}`) || fallback; } catch (e) { return fallback; }
}
function remember(key, value) {
  try { window.localStorage.setItem(`jake-planner-${key}`, value); } catch (e) { /* the view works without it */ }
}

class PlannerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.tab = memo("tab", "calendar");
    this.lane = memo("lane", "All");
    const today = isoDate(new Date());
    this.selected = today;
    this.month = today.slice(0, 7);
    this.opened = new Set();
    this.deadline = "";
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Planner"; }
  getIcon() { return "calendar-check"; }

  async onOpen() {
    const root = this.contentEl;
    root.innerHTML = "";
    root.classList.add("jp-root");
    if (Platform.isPhone) root.classList.add("is-phone");
    this.header = el("div", "jp-header", null, root);
    el("div", "jp-glass jp-glass-top", null, this.header);
    this.buildTabs();
    this.scroller = el("div", "jp-scroll", null, root);
    this.toastEl = el("div", "jp-toast", null, root);
    this.buildComposer(root);
    this.unsubscribe = this.store.subscribe(() => this.render());
    this.render();
  }

  async onClose() {
    if (this.unsubscribe) this.unsubscribe();
    clearTimeout(this.toastTimer);
  }

  setTab(tab) {
    this.tab = tab;
    remember("tab", tab);
    this.syncTabs();
    this.render();
    this.scroller.scrollTop = 0;
  }

  buildTabs() {
    const seg = el("div", "jp-seg", null, this.header);
    this.thumb = el("div", "jp-seg-thumb", null, seg);
    this.tabButtons = {};
    for (const [id, label] of [["calendar", "Calendar"], ["tasks", "Tasks"]]) {
      this.tabButtons[id] = button("jp-seg-btn", null, seg, () => this.setTab(id));
      this.tabButtons[id].textContent = label;
    }
    this.syncTabs();
  }

  syncTabs() {
    const on = this.tab === "tasks" ? 1 : 0;
    this.thumb.style.transform = `translateX(${on * 100}%)`;
    Object.entries(this.tabButtons).forEach(([id, b]) => {
      b.classList.toggle("is-active", id === this.tab);
      b.setAttribute("aria-pressed", String(id === this.tab));
    });
    if (this.input) this.syncComposer();
  }

  buildComposer(root) {
    const wrap = el("div", "jp-composer", null, root);
    el("div", "jp-glass jp-glass-bottom", null, wrap);
    this.chip = button("jp-chip", "Remove the deadline", wrap, () => this.setDeadline(""));
    const field = el("form", "jp-field", null, wrap);
    this.input = el("input", "jp-input", null, field);
    this.input.type = "text";
    this.input.enterKeyHint = "send";
    // The real date input sits invisibly over the icon, so a tap opens the phone's own picker.
    this.dateBtn = el("span", "jp-icon-btn jp-field-btn", null, field);
    icon("date", "", this.dateBtn);
    this.dateInput = el("input", "jp-date-input", null, this.dateBtn);
    this.dateInput.type = "date";
    this.dateInput.setAttribute("aria-label", "Set a deadline");
    this.dateInput.addEventListener("click", () => {
      try { this.dateInput.showPicker(); } catch (e) { /* this device opens its picker on tap anyway */ }
    });
    this.dateInput.addEventListener("change", () => this.setDeadline(this.dateInput.value));
    this.send = el("button", "jp-send", null, field);
    this.send.type = "submit";
    this.send.setAttribute("aria-label", "Add");
    icon("up", "", this.send);
    this.input.addEventListener("input", () => this.syncComposer());
    field.addEventListener("submit", (e) => { e.preventDefault(); this.submit(); });
    this.syncComposer();
  }

  syncComposer() {
    const tasks = this.tab === "tasks";
    this.input.placeholder = tasks ? "New task" : "Dentist tomorrow 3pm";
    this.input.setAttribute("aria-label", tasks ? "New task" : "New calendar event");
    this.dateBtn.style.display = tasks ? "" : "none";
    this.send.disabled = !this.input.value.trim();
    this.chip.style.display = tasks && this.deadline ? "" : "none";
  }

  setDeadline(iso) {
    this.deadline = iso;
    this.dateInput.value = iso;
    this.chip.textContent = iso ? `Due ${shortDate(iso)}  ×` : "";
    this.syncComposer();
  }

  async submit() {
    const text = this.input.value.trim();
    if (!text) return;
    const wasTasks = this.tab === "tasks";
    this.send.disabled = true;
    try {
      if (wasTasks) await this.store.addTask(text, this.deadline);
      else await this.store.addEvent(text);
      this.input.value = "";
      this.setDeadline("");
      this.toast(wasTasks ? "Added to your Inbox" : "Sent. It reaches your calendars within 2 minutes.");
    } catch (e) {
      new Notice(`Planner: ${e.message}`);
    }
    this.syncComposer();
  }

  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("is-on");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove("is-on"), 3200);
  }

  render() {
    if (!this.scroller) return;
    const top = this.scroller.scrollTop;
    this.scroller.innerHTML = "";
    const now = new Date();
    if (!this.store.ready) el("div", "jp-empty", "Reading your notes…", this.scroller);
    else if (this.tab === "tasks") this.renderTasks(now);
    else this.renderCalendar(now);
    this.scroller.scrollTop = top;
  }

  /* ---------- calendar ---------- */
  renderCalendar(now) {
    const today = isoDate(now);
    const tasks = this.store.tasks;
    const wrap = el("div", "jp-cal", null, this.scroller);
    const left = el("div", "jp-cal-month", null, wrap);
    const right = el("div", "jp-cal-day", null, wrap);

    const [year, month] = this.month.split("-").map(Number);
    const bar = el("div", "jp-month-bar", null, left);
    el("div", "jp-month-title", `${MONTHS[month - 1]} ${year}`, bar);
    if (this.selected !== today) {
      const go = button("jp-plain", null, bar, () => { this.selected = today; this.month = today.slice(0, 7); this.render(); });
      go.textContent = "Today";
    }
    const shift = (n) => {
      const d = new Date(year, month - 1 + n, 1);
      this.month = isoDate(d).slice(0, 7);
      this.render();
    };
    icon("back", "", button("jp-icon-btn", "Previous month", bar, () => shift(-1)));
    icon("next", "", button("jp-icon-btn", "Next month", bar, () => shift(1)));

    const grid = el("div", "jp-grid", null, left);
    for (const d of WEEKDAYS) el("div", "jp-grid-head", d[0], grid);
    const first = new Date(year, month - 1, 1);
    for (let i = 0; i < first.getDay(); i++) el("div", "jp-cell is-blank", null, grid);
    const count = new Date(year, month, 0).getDate();
    for (let n = 1; n <= count; n++) {
      const iso = `${year}-${pad(month)}-${pad(n)}`;
      const agenda = dayAgenda(iso, this.store.calendar, tasks);
      const cell = button("jp-cell", longDate(iso), grid, () => { this.selected = iso; this.render(); });
      if (iso === today) cell.classList.add("is-today");
      if (iso === this.selected) cell.classList.add("is-selected");
      if (iso < today) cell.classList.add("is-past");
      el("span", "jp-cell-num jp-num", String(n), cell);
      const dots = el("span", "jp-dots", null, cell);
      const items = [...agenda.allDay, ...agenda.timed];
      if (items.some((x) => !x.workBlock)) el("i", "jp-mark is-event", null, dots);
      if (items.some((x) => x.workBlock)) el("i", "jp-mark is-block", null, dots);
      if (agenda.due.some((t) => !t.done)) el("i", "jp-mark is-due", null, dots);
    }
    const key = el("div", "jp-key", null, left);
    for (const [cls, label] of [["is-event", "Event"], ["is-block", "Work block"], ["is-due", "Due"]]) {
      const k = el("span", "jp-key-item", null, key);
      el("i", `jp-mark ${cls}`, null, k);
      el("span", "", label, k);
    }

    this.renderDay(right, this.selected, now, tasks);
  }

  renderDay(parent, iso, now, tasks) {
    const today = isoDate(now);
    const label = iso === today ? `Today · ${longDate(iso)}` : iso === addDays(today, 1) ? `Tomorrow · ${longDate(iso)}` : longDate(iso);
    el("div", "jp-section", label, parent);
    const { allDay, timed, due } = dayAgenda(iso, this.store.calendar, tasks);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (allDay.length || timed.length) {
      const card = el("div", "jp-card", null, parent);
      for (const ev of allDay) this.eventRow(card, { title: ev.title, workBlock: ev.workBlock, time: "all-day" }, now);
      for (const ev of timed) {
        const past = iso < today || (iso === today && ev.endMin <= nowMin);
        const live = iso === today && ev.startMin <= nowMin && nowMin < ev.endMin;
        this.eventRow(card, {
          title: ev.title, workBlock: ev.workBlock, past, live,
          time: clock(ev.startMin), until: clock(ev.endMin),
        }, now);
      }
    } else if (!due.length) {
      el("div", "jp-card jp-none", "Nothing scheduled", parent);
    }
    if (due.length) {
      el("div", "jp-section", "Due", parent);
      const card = el("div", "jp-card", null, parent);
      for (const t of due) this.taskRow(card, t, now);
    }
    const dates = [...this.store.calendar.keys()].sort();
    const covered = dates.length && iso >= dates[0] && iso <= addDays(dates[0], CALENDAR_DAYS - 1);
    if (!covered) {
      el("div", "jp-foot", `Events come from your Calendar note, which keeps the next ${CALENDAR_DAYS} days. Due tasks still show here.`, parent);
    } else if (this.store.calendarTime) {
      el("div", "jp-foot", `Calendar updated ${timeAgo(this.store.calendarTime, now)}`, parent);
    }
  }

  eventRow(card, row, now) {
    const node = el("div", "jp-row jp-event", null, card);
    if (row.past) node.classList.add("is-past");
    if (row.live) node.classList.add("is-live");
    const time = el("div", "jp-time jp-num", null, node);
    el("div", "", row.time, time);
    if (row.until) el("div", "jp-time-2", row.until, time);
    const text = el("div", `jp-row-text ${row.workBlock ? "is-block" : ""}`.trim(), null, node);
    el("div", "jp-row-title", row.title, text);
  }

  /* ---------- tasks ---------- */
  renderTasks(now) {
    const wrap = el("div", "jp-tasks", null, this.scroller);
    const all = this.store.tasks;
    const lanes = LANES.filter((l) => all.some((t) => !t.done && t.fields.lane === l));
    if (lanes.length) {
      const chips = el("div", "jp-lanes", null, wrap);
      for (const lane of ["All", ...lanes]) {
        const b = button(`jp-lane ${lane === this.lane ? "is-active" : ""}`.trim(), null, chips, () => {
          this.lane = lane;
          remember("lane", lane);
          this.render();
        });
        b.textContent = lane;
      }
    }
    const lane = this.lane === "All" || lanes.includes(this.lane) ? this.lane : "All";
    const buckets = bucketTasks(lane === "All" ? all : all.filter((t) => t.fields.lane === lane), now);
    let drew = false;
    const section = (title, rows, note) => {
      if (!rows.length) return;
      drew = true;
      el("div", "jp-section", title, wrap);
      if (note) el("div", "jp-note", note, wrap);
      const card = el("div", "jp-card", null, wrap);
      rows.forEach((t) => this.taskRow(card, t, now));
    };
    section("Overdue", buckets.overdue);
    section("Today", buckets.today);
    section("Coming up", buckets.upcoming);
    section("No date", buckets.someday);
    if (!drew) el("div", "jp-empty", lane === "All" ? "No open tasks. Add one below." : `No open ${lane} tasks.`, wrap);

    const email = lane === "All" || lane === "Work" ? this.store.email : [];
    this.collapsible(wrap, "email", "From email", email, (card) => {
      el("div", "jp-note jp-note-in", "None of these are tasks yet. Tap Book to make one.", card);
      email.forEach((item) => this.emailRow(card, item));
    });
    this.collapsible(wrap, "done", "Done, last 7 days", buckets.done, (card) => {
      buckets.done.forEach((t) => this.taskRow(card, t, now));
    });
  }

  collapsible(parent, id, title, rows, fill) {
    if (!rows.length) return;
    const open = this.opened.has(id);
    const head = button("jp-section jp-section-btn", null, parent, () => {
      if (open) this.opened.delete(id);
      else this.opened.add(id);
      this.render();
    });
    head.setAttribute("aria-expanded", String(open));
    el("span", "", `${title} (${rows.length})`, head);
    icon(open ? "down" : "next", "jp-ico-xs", head);
    if (open) fill(el("div", "jp-card", null, parent));
  }

  taskRow(card, task, now) {
    const node = el("div", "jp-row jp-task is-tappable", null, card);
    if (task.done) node.classList.add("is-done");
    this.tickButton(node, task);
    const text = el("div", "jp-row-text", null, node);
    el("div", "jp-row-title", task.title || task.raw.trim(), text);
    const caption = taskCaption(task, now);
    if (caption) {
      const c = el("div", "jp-caption", caption, text);
      if (!task.done && ((task.deadline && task.deadline < isoDate(now)) || task.fields.atrisk)) c.classList.add("is-late");
    }
    if (task.source) el("div", "jp-caption", `From ${task.source}`, text);
    this.linkButton(node, task.fields.url);
    node.addEventListener("click", () => this.openTask(task));
  }

  emailRow(card, item) {
    const node = el("div", "jp-row jp-task is-tappable", null, card);
    const text = el("div", "jp-row-text", null, node);
    el("div", "jp-row-title", item.title, text);
    if (item.source) el("div", "jp-caption", `From ${item.source}`, text);
    this.linkButton(node, item.fields.url);
    const book = button("jp-book", `Book ${item.title}`, node, async () => {
      try {
        await this.store.book(item);
        this.toast("Booked as a task");
      } catch (e) {
        new Notice(`Planner: ${e.message}`);
      }
    });
    book.textContent = "Book";
    node.addEventListener("click", () => this.openTask(item));
  }

  tickButton(row, task) {
    const b = button(`jp-tick ${task.done ? "is-on" : ""}`.trim(), task.done ? `Mark not done: ${task.title}` : `Mark done: ${task.title}`, row, async () => {
      b.classList.toggle("is-on");
      try {
        await this.store.setDone(task, !task.done);
      } catch (e) {
        new Notice(`Planner: ${e.message}`);
        this.render();
      }
    });
    icon("check", "", el("span", "jp-tick-ring", null, b));
  }

  linkButton(row, url) {
    if (!/^https?:\/\//.test(url || "")) return;
    icon("open", "jp-ico-sm", button("jp-icon-btn jp-link", "Open the link", row, () => window.open(url)));
  }

  async openTask(item) {
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (!(file instanceof TFile)) return;
    await this.app.workspace.getLeaf(false).openFile(file, { eState: { line: item.line } });
    if (Platform.isPhone && this.app.workspace.rightSplit) this.app.workspace.rightSplit.collapse();
  }
}

function timeAgo(then, now) {
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}

module.exports = class PlannerPlugin extends Plugin {
  async onload() {
    this.store = new Store(this.app);
    this.registerView(VIEW_TYPE, (leaf) => new PlannerView(leaf, this));
    this.addRibbonIcon("calendar-days", "Open calendar", () => this.activate("calendar"));
    this.addRibbonIcon("list-checks", "Open tasks", () => this.activate("tasks"));
    this.addCommand({ id: "open-calendar", name: "Open calendar", callback: () => this.activate("calendar") });
    this.addCommand({ id: "open-tasks", name: "Open tasks", callback: () => this.activate("tasks") });
    this.app.workspace.onLayoutReady(async () => {
      await this.store.loadAll();
      // Registered after the first read, because Obsidian fires "create" for every file on startup.
      const { vault, metadataCache } = this.app;
      this.registerEvent(vault.on("modify", (f) => this.store.changed(f)));
      this.registerEvent(vault.on("create", (f) => this.store.changed(f)));
      this.registerEvent(vault.on("delete", (f) => this.store.removed(f.path)));
      this.registerEvent(vault.on("rename", (f, old) => { this.store.removed(old); this.store.changed(f); }));
      // Notes still being indexed on the first read get picked up once Obsidian finishes.
      const once = metadataCache.on("resolved", () => { metadataCache.offref(once); this.store.loadAll(); });
      this.registerEvent(once);
    });
    // Moves the "now" highlight along and keeps "Today" right past midnight.
    this.registerInterval(window.setInterval(() => this.store.emit(), 60000));
  }

  async activate(tab) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) || workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (leaf.loadIfDeferred) await leaf.loadIfDeferred();
    if (leaf.view instanceof PlannerView) leaf.view.setTab(tab);
    return leaf.view;
  }
};

// For test/ only; Obsidian ignores these.
module.exports.core = {
  parseBody, parseTask, parseNote, parseEmail, tickLine, untickLine, bookLine, replaceLine, newTaskLine,
  appendLine, appendEvent, headingDate, parseSpan, parseCalendar, bucketTasks, dayAgenda,
  taskCaption, inScope, isoDate, Store,
};

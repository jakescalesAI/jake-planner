// Runs in the page: opens the real view and drives it the way a person would.
const q = new URLSearchParams(location.search);
document.body.classList.add(`theme-${q.get("theme") || "dark"}`);
const pane = document.getElementById("pane");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra) => results.push(`${ok ? "ok" : "FAIL"} - ${name}${extra ? ` (${extra})` : ""}`);
const INBOX = "0 Home/2 Tasks/Inbox.md", CANVAS = "0 Home/2 Tasks/Canvas.md", EMAIL = "0 Home/2 Tasks/Email.md";
const CAL = "0 Home/3 Schedule/Calendar.md", ADD = "0 Home/3 Schedule/Add to calendar.md";
const rowWith = (t) => [...pane.querySelectorAll(".jp-row")].find((r) => r.textContent.includes(t));
const titles = () => [...pane.querySelectorAll(".jp-row-title")].map((n) => n.textContent);
const tabBtn = (name) => [...pane.querySelectorAll(".jp-seg-btn")].find((b) => b.textContent === name);
const type = (text) => { const i = pane.querySelector(".jp-input"); i.value = text; i.dispatchEvent(new Event("input")); pane.querySelector(".jp-field").requestSubmit(); };

(async () => {
  const Planner = module.exports;
  const plugin = new Planner();
  try { localStorage.setItem("jake-planner-tab", q.get("tab") || "calendar"); localStorage.removeItem("jake-planner-lane"); } catch (e) {}
  await plugin.onload();
  const view = plugin.make(pluginLeaf);
  pluginLeaf.view = view;
  await view.onOpen();
  await wait(50);
  const day = q.get("day");
  if (day) { view.selected = day; view.render(); }
  if (q.get("open")) { q.get("open").split(",").forEach((o) => view.opened.add(o)); view.render(); }
  if (q.get("bottom")) view.scroller.scrollTop = 1e6;
  if (!q.get("run")) return;

  const today = module.exports.core.isoDate(new Date());
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  check("month grid has a cell per day", pane.querySelectorAll(".jp-cell:not(.is-blank)").length === month);
  check("today is marked and selected", pane.querySelector(".jp-cell.is-today.is-selected") !== null);
  const realEvents = module.exports.core.parseCalendar(texts.get(CAL), now).get(today) || [];
  check("today's rows match Calendar.md", pane.querySelectorAll(".jp-event").length >= realEvents.length, `${pane.querySelectorAll(".jp-event").length} rows, ${realEvents.length} events`);

  // Tick a due task from the calendar, on its due day.
  syncIn("2 Thoughts/tick check.md", `first line\n- [ ] Tick me from the calendar 📅 ${today}\nlast line\n`);
  await wait(300);
  const dueTask = plugin.store.tasks.find((t) => t.title === "Tick me from the calendar");
  const before = texts.get(dueTask.path);
  view.selected = today; view.month = view.selected.slice(0, 7); view.render();
  check("a task never gets a timed row", ![...pane.querySelectorAll(".jp-event")].some((r) => r.textContent.includes(dueTask.title)));
  const row = rowWith(dueTask.title);
  check("a due task shows on its day with a tick", !!row && !!row.querySelector(".jp-tick"), dueTask.title.slice(0, 40));
  row.querySelector(".jp-tick").click();
  await wait(50);
  const lineAfter = texts.get(dueTask.path).split("\n")[dueTask.line];
  check("ticking from the calendar writes [x] and ✅ today", lineAfter === `${dueTask.raw.trimEnd().replace("- [ ]", "- [x]")} ✅ ${today}`);
  check("every other line in the note is untouched", texts.get(dueTask.path).split("\n").filter((_, i) => i !== dueTask.line).join("\n") === before.split("\n").filter((_, i) => i !== dueTask.line).join("\n"));
  check("the row shows as done", rowWith(dueTask.title).classList.contains("is-done"));
  rowWith(dueTask.title).querySelector(".jp-tick").click();
  await wait(50);
  check("unticking restores the note byte for byte", texts.get(dueTask.path) === before);

  // Tasks tab.
  tabBtn("Tasks").click();
  await wait(20);
  const open = plugin.store.tasks.filter((t) => !t.done);
  check("every open task is on the Tasks tab", open.every((t) => titles().includes(t.title)), `${open.length} open`);
  check("a lane filter narrows the list", (() => { [...pane.querySelectorAll(".jp-lane")].find((b) => b.textContent === "School").click(); return titles().length === open.filter((t) => t.fields.lane === "School").length; })());
  [...pane.querySelectorAll(".jp-lane")].find((b) => b.textContent === "All").click();

  // Adding.
  view.setDeadline("2026-12-01");
  type("Plugin test task <img src=x onerror=alert(1)>");
  await wait(50);
  check("a new task lands at the end of Inbox with its deadline", texts.get(INBOX).trimEnd().endsWith("- [ ] Plugin test task <img src=x onerror=alert(1)> 📅 2026-12-01"));
  check("it shows at once", titles().some((t) => t.startsWith("Plugin test task")));
  check("a title can't inject HTML", pane.querySelector(".jp-row-title img") === null);
  tabBtn("Calendar").click();
  await wait(20);
  type("Plugin test event tomorrow 3pm");
  await wait(50);
  const add = texts.get(ADD);
  check("a new event lands under ## Events", add.slice(add.indexOf("## Events")).includes("- Plugin test event tomorrow 3pm") && !add.slice(0, add.indexOf("## Events")).includes("Plugin test event"));

  // Sync landing while it's open: no reload.
  tabBtn("Tasks").click();
  await wait(20);
  syncIn(INBOX, `${texts.get(INBOX)}- [ ] Arrived from the iPhone\n`);
  await wait(300);
  check("a task synced from another device appears without a reload", titles().includes("Arrived from the iPhone"));
  syncIn("2 Thoughts/brand new.md", "- [ ] Written in a brand new note\n");
  await wait(300);
  check("so does one in a new note", titles().includes("Written in a brand new note"));
  syncIn("1 AgentHub/skip.md", "- [ ] Must stay hidden\n");
  await wait(300);
  check("AgentHub checkboxes stay out", !titles().includes("Must stay hidden"));
  syncIn(CAL, `${texts.get(CAL).replace(/## Today · [^\n]*\n/, (h) => `${h}- 9:00–9:30 AM · Added by calsync\n`)}`);
  await wait(300);
  tabBtn("Calendar").click();
  await wait(20);
  view.selected = today; view.render();
  check("Calendar.md rebuilt by calsync redraws without a reload", titles().includes("Added by calsync"));

  // The note sorter moving a note, or a note moved out of scope, leaves nothing stale behind.
  const moved = files.get("2 Thoughts/brand new.md");
  files.delete(moved.path);
  const oldPath = moved.path;
  moved.path = "1 AgentHub/moved.md";
  files.set(moved.path, moved);
  texts.set(moved.path, texts.get(oldPath));
  plugin.store.removed(oldPath);
  plugin.store.changed(moved);
  await wait(300);
  tabBtn("Tasks").click();
  check("a note moved out of scope drops off", !titles().includes("Written in a brand new note"));
  tabBtn("Calendar").click();

  // A note edited elsewhere between the read and the tick.
  const canvas = plugin.store.byPath.get(CANVAS)[0];
  const shifted = `Line added on the phone\n${texts.get(CANVAS)}`;
  texts.set(CANVAS, shifted);
  await plugin.store.setDone(canvas, true);
  check("a tick lands on the right line after the note shifted", texts.get(CANVAS).split("\n")[canvas.line + 1].startsWith(`- [x] ${canvas.raw.slice(6, 30)}`));
  texts.set(INBOX, "emptied");
  const gone = plugin.store.byPath.get(INBOX)[0];
  let refused = false;
  try { await plugin.store.setDone(gone, true); } catch (e) { refused = true; }
  check("a tick is refused, and nothing written, if the line is gone", refused && texts.get(INBOX) === "emptied");

  // Email.
  tabBtn("Tasks").click();
  view.opened.add("email"); view.render();
  const emailBefore = plugin.store.email.length;
  check("email suggestions are listed", pane.querySelectorAll(".jp-book").length === emailBefore && emailBefore > 0, `${emailBefore}`);
  const item = plugin.store.email[0];
  pane.querySelector(".jp-book").click();
  await wait(50);
  check("Book turns the bullet into a checkbox", texts.get(EMAIL).split("\n")[item.line] === item.raw.replace(/^- /, "- [ ] "));
  check("and it moves into the task list", plugin.store.email.length === emailBefore - 1 && plugin.store.tasks.some((t) => t.title === item.title));

  // Opening.
  rowWith(item.title).click();
  await wait(20);
  check("tapping a task opens its note at its line", opened.length === 1 && opened[0][0] === EMAIL && opened[0][1] === item.line);

  check("no errors shown", notices.length === 0, notices.join("; "));
  document.getElementById("result").textContent = results.join("\n");
})().catch((e) => { document.getElementById("result").textContent = `CRASH ${e.stack}`; });

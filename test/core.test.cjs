// node test/core.test.cjs [vault path]: the parsers and line edits, plus a read-only cross-check
// against a real vault when one is given.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const load = Module._load;
Module._load = function (name, ...rest) {
  if (name === "obsidian") return { Plugin: class {}, ItemView: class {}, Notice: class {}, Platform: {}, TFile: class {} };
  return load.call(this, name, ...rest);
};
const { core } = require("../main.js");
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const now = new Date(2026, 10, 2, 13, 0); // Mon Nov 2 2026, 1:00 PM

const LINE = "- [ ] Write the proposal (from Vasantha) 📅 2026-11-05 [est:: 2h] [lane:: Work] [due_time:: 5:30 PM] [moved:: 2] [atrisk:: yes] [url:: https://x.test/a?b=1] #fixed";

test("a task line gives up every field and a clean title", () => {
  const t = core.parseTask(LINE, "n.md", 4);
  assert.strictEqual(t.title, "Write the proposal");
  assert.strictEqual(t.source, "Vasantha");
  assert.strictEqual(t.deadline, "2026-11-05");
  assert.strictEqual(t.fields.est, "2h");
  assert.strictEqual(t.fields.lane, "Work");
  assert.strictEqual(t.fields.due_time, "5:30 PM");
  assert.strictEqual(t.fields.url, "https://x.test/a?b=1");
  assert.strictEqual(t.fields.atrisk, "yes");
  assert.ok(t.fixed && !t.done);
  assert.strictEqual(t.line, 4);
});
test("links in a title read as plain words", () => {
  assert.strictEqual(core.parseTask("- [ ] See [[a/b|the note]] and [site](http://x.y) and [[c]]", "n", 0).title, "See the note and site and c");
});
test("not tasks: prose, plain bullets, fenced examples", () => {
  const tasks = core.parseNote("text\n- plain\n```\n- [ ] example\n```\n~~~tasks\n- [ ] q\n~~~\n  - [x] real nested ✅ 2026-11-01\n", "n");
  assert.strictEqual(tasks.length, 1);
  assert.ok(tasks[0].done);
  assert.strictEqual(tasks[0].doneDate, "2026-11-01");
  assert.strictEqual(tasks[0].line, 8);
});
test("ticking matches the scheduler's own format and keeps every field", () => {
  const out = core.tickLine(LINE, "2026-11-02");
  assert.strictEqual(out, LINE.replace("- [ ]", "- [x]") + " ✅ 2026-11-02");
  assert.ok(/^\s*- \[[xX]\] (.*)$/.test(out));
});
test("ticking a Windows-line-ending note keeps the line ending", () => {
  assert.strictEqual(core.tickLine("- [ ] a\r", "2026-11-02"), "- [x] a ✅ 2026-11-02\r");
  assert.strictEqual(core.parseTask("- [ ] a\r", "n", 0).title, "a");
});
test("unticking undoes ticking exactly", () => {
  assert.strictEqual(core.untickLine(core.tickLine(LINE, "2026-11-02")), LINE);
  assert.strictEqual(core.untickLine("  - [X] b ✅ 2026-11-01 [est:: 1h]"), "  - [ ] b [est:: 1h]");
});
test("an edit lands on the right line even after the note shifted", () => {
  const item = { line: 0, raw: "- [ ] a" };
  assert.strictEqual(core.replaceLine("new\n- [ ] a\nz", item, (l) => l + "!"), "new\n- [ ] a!\nz");
  assert.strictEqual(core.replaceLine("- [ ] a\n- [ ] b", item, (l) => l + "!"), "- [ ] a!\n- [ ] b");
});
test("an edit refuses when the line is gone or ambiguous", () => {
  const item = { line: 5, raw: "- [ ] a" };
  assert.throws(() => core.replaceLine("x", item, (l) => l), /changed/);
  assert.throws(() => core.replaceLine("- [ ] a\n- [ ] a", item, (l) => l), /changed/);
});
test("new tasks and events land where their notes want them", () => {
  assert.strictEqual(core.newTaskLine("  call  Sam ", "2026-11-05"), "- [ ] call Sam 📅 2026-11-05");
  assert.strictEqual(core.newTaskLine("- [ ] typed box", ""), "- [ ] typed box");
  assert.strictEqual(core.appendLine("# Inbox\n\n- [ ] a\n\n", "- [ ] b"), "# Inbox\n\n- [ ] a\n- [ ] b\n");
  const note = "# Add\n```\n- Dentist tomorrow 3pm\n```\n\n## Events\n\n";
  assert.strictEqual(core.appendEvent(note, "Gym fri 6am"), "# Add\n```\n- Dentist tomorrow 3pm\n```\n\n## Events\n- Gym fri 6am\n");
  assert.strictEqual(core.appendEvent("## Events\n- ✅ Old → Mon\n\n## After\nx\n", "- New"), "## Events\n- ✅ Old → Mon\n- New\n\n## After\nx\n");
});
test("email suggestions: bullets only, and booking makes a checkbox", () => {
  const items = core.parseEmail("# Email\n\nIntro\n\n- Reply to Julia (from j@x.com, +2 more) [est:: 15m] [url:: https://m.test]\n- [ ] accepted\n");
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, "Reply to Julia");
  assert.strictEqual(items[0].source, "j@x.com, +2 more");
  assert.strictEqual(core.bookLine(items[0].raw).slice(0, 13), "- [ ] Reply t");
});
test("calendar times in every form calsync writes", () => {
  assert.deepStrictEqual(core.parseSpan("9:00–10:15 AM"), { startMin: 540, endMin: 615 });
  assert.deepStrictEqual(core.parseSpan("12:00–1:15 PM"), { startMin: 720, endMin: 795 });
  assert.deepStrictEqual(core.parseSpan("11:45 AM–3:00 PM"), { startMin: 705, endMin: 900 });
  assert.deepStrictEqual(core.parseSpan("11:00 PM–1:00 AM"), { startMin: 1380, endMin: 1500 });
  assert.deepStrictEqual(core.parseSpan("12:15–12:45 AM"), { startMin: 15, endMin: 45 });
  assert.strictEqual(core.parseSpan("soon"), null);
});
test("calendar headings get the nearest year, including across New Year", () => {
  assert.strictEqual(core.headingDate("Today · Monday, November 2", now), "2026-11-02");
  assert.strictEqual(core.headingDate("Friday, January 1", new Date(2026, 11, 30)), "2027-01-01");
  assert.strictEqual(core.headingDate("Not a date", now), "");
});
test("Calendar.md parses: all-day, a Work block, a title with its own separator, nothing scheduled", () => {
  const days = core.parseCalendar("# Calendar\n\nEvery calendar.\n\n## Today · Monday, November 2\n- All day · Trip\n- 9:00–10:15 AM · CSCI · lab\n- 1:00–1:30 PM · Work block\n\n## Tomorrow · Tuesday, November 3\n- Nothing scheduled\n", now);
  assert.strictEqual(days.get("2026-11-02").length, 3);
  assert.strictEqual(days.get("2026-11-02")[1].title, "CSCI · lab");
  assert.ok(days.get("2026-11-02")[0].allDay);
  assert.ok(days.get("2026-11-02")[2].workBlock);
  assert.ok(!days.get("2026-11-02")[1].workBlock);
  assert.deepStrictEqual(days.get("2026-11-03"), []);
});
test("tasks sort into the right sections, each in one place", () => {
  const list = [
    "- [ ] late 📅 2026-10-30", "- [ ] today 📅 2026-11-02", "- [ ] soon 📅 2026-11-04", "- [ ] sooner 📅 2026-11-03",
    "- [ ] whenever", "- [x] finished ✅ 2026-11-01", "- [x] long ago ✅ 2026-01-01",
  ].map((l, i) => core.parseTask(l, "n", i));
  const b = core.bucketTasks(list, now);
  const titles = (a) => a.map((t) => t.title);
  assert.deepStrictEqual(titles(b.overdue), ["late"]);
  assert.deepStrictEqual(titles(b.today), ["today"]);
  assert.deepStrictEqual(titles(b.upcoming), ["sooner", "soon"]);
  assert.deepStrictEqual(titles(b.someday), ["whenever"]);
  assert.deepStrictEqual(titles(b.done), ["finished"]);
});
test("a day's agenda: events and Work blocks hold time, tasks are only due", () => {
  const cal = core.parseCalendar("## Monday, November 2\n- 2:00–4:00 PM · Work block\n- 2:30–3:00 PM · Call\n", now);
  const due = core.parseTask("- [ ] Hand in 📅 2026-11-02 [est:: 2h]", "n", 2);
  const old = core.parseTask("- [ ] Old 📅 2026-11-09 [block:: 2026-11-02 09:00-10:00]", "n", 3);
  const day = core.dayAgenda("2026-11-02", cal, [due, old]);
  assert.deepStrictEqual(day.timed.map((r) => r.title), ["Work block", "Call"]);
  assert.ok(day.timed[0].workBlock && !day.timed[1].workBlock);
  assert.deepStrictEqual(day.due.map((t) => t.title), ["Hand in"]);
});
test("an at-risk task says so", () => {
  const risk = core.parseTask("- [ ] x 📅 2026-11-03 [atrisk:: yes]", "n", 0);
  const fine = core.parseTask("- [ ] y 📅 2026-11-03", "n", 0);
  assert.ok(core.taskCaption(risk, now).includes("At risk"));
  assert.ok(!core.taskCaption(fine, now).includes("At risk"));
});
test("the same folders are left out as on Home", () => {
  for (const p of ["0 Home/5 AgentHub/9 Raw copy (read-only)/x.md", "1 AgentHub/x.md", "7 Scraper/x.md", "10 Money/Bank/x.md", "0 Home/4 Templates/t.md", "0 Home/0 Quartzi Copilot/c.md", "0 Home/2 Tasks/README.md", "a.png"]) assert.ok(!core.inScope(p), p);
  for (const p of ["0 Home/2 Tasks/Inbox.md", "2 Thoughts/n.md", "CLAUDE.md"]) assert.ok(core.inScope(p), p);
});

const vault = process.argv[2];
if (vault) {
  const walk = (dir, rel = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === ".obsidian" || e.name === ".trash" || e.name === ".git" || r === "10 Money") return [];
    return e.isDirectory() ? walk(path.join(dir, e.name), r) : [r];
  });
  const files = walk(vault).filter(core.inScope);
  const read = (f) => fs.readFileSync(path.join(vault, f), "utf8");
  const tasks = files.flatMap((f) => core.parseNote(read(f), f));
  const open = tasks.filter((t) => !t.done);
  test(`real vault: every open checkbox found (${open.length} open, ${tasks.length} total, ${files.length} notes)`, () => {
    const rawOpen = files.flatMap((f) => read(f).split("\n").filter((l) => /^\s*- \[ \] /.test(l)));
    assert.strictEqual(open.length, rawOpen.length);
  });
  test("real vault: no open task lost its title", () => {
    assert.deepStrictEqual(open.filter((t) => !t.title).map((t) => t.raw), []);
  });
  test("real vault: every Calendar.md event line parsed", () => {
    const text = read("0 Home/3 Schedule/Calendar.md");
    const lines = text.split("\n").filter((l) => l.startsWith("- ") && l !== "- Nothing scheduled" && l.includes(" · "));
    const days = core.parseCalendar(text, new Date());
    assert.strictEqual([...days.values()].flat().length, lines.length);
    assert.ok(days.size > 0);
  });
  test("real vault: no task line still holds time", () => {
    assert.deepStrictEqual(tasks.filter((t) => /⏳|\[block::|\[gcal::/u.test(t.raw)).map((t) => t.raw), []);
  });
  test("real vault: at-risk tasks", () => {
    const risk = open.filter((t) => t.fields.atrisk);
    console.log(`     ${risk.length} of ${open.length}`);
  });
  test("real vault: ticking then unticking every task returns the exact line", () => {
    for (const t of open) assert.strictEqual(core.untickLine(core.tickLine(t.raw, "2026-11-02")), t.raw);
  });
}
console.log(`\n${passed} passed`);

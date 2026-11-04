// node test/phone.cjs <built page folder>: runs the harness page's checks in Chromium at 390px, a
// phone's width. Build the page first with test/harness.cjs, into a folder outside this repo.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const page = fs.readFileSync(path.join(process.argv[2], "index.html"), "utf8");
const cache = path.join(os.homedir(), ".cache/ms-playwright");
const chrome = path.join(cache, fs.readdirSync(cache).filter((n) => n.startsWith("chromium-")).sort().pop(), "chrome-linux/chrome");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "planner-phone-"));
const wrapper = `<!doctype html><body style="margin:0"><iframe id="f" src="/app?run=1" width="390" height="844" style="border:0"></iframe>
<script>const t = setInterval(() => { const w = document.getElementById("f").contentWindow, r = w.document.getElementById("result");
if (r && r.textContent.trim()) { clearInterval(t); fetch("/report", { method: "POST", body: JSON.stringify({ text: r.textContent, width: w.innerWidth, phone: !!w.document.querySelector(".jp-root.is-phone"), sideways: w.document.documentElement.scrollWidth > w.innerWidth }) }); } }, 100);</script>`;
let proc;
const finish = (code, text) => { console.log(text); try { process.kill(-proc.pid); } catch (e) { /* gone */ } fs.rmSync(profile, { recursive: true, force: true }); process.exit(code); };
const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      res.end("ok");
      const r = JSON.parse(raw);
      const bad = r.text.trim().split("\n").some((l) => !l.startsWith("ok")) || !r.phone || r.sideways || r.width !== 390;
      finish(bad ? 1 : 0, `${r.text.trim().split("\n").slice(-12).join("\n")}\nwidth ${r.width}, phone layout ${r.phone}, sideways scroll ${r.sideways}`);
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url.startsWith("/app") ? page : wrapper);
});
server.listen(0, "127.0.0.1", () => {
  proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`], { stdio: "ignore", detached: true });
  setTimeout(() => finish(1, "NOT OK - the page never reported"), 60000);
});

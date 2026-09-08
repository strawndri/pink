/** Regression test for the page layer stack, run in a real browser.
 *
 * The highlight tool depends on the user being able to select text through the
 * annotation overlay. That is a pure CSS/hit-testing property, so it is checked
 * against the real styles.css rather than reasoned about.
 *
 * Requires firefox and geckodriver on PATH. Run from the repo root:
 *   node test/browser/layers.mjs
 * The repo must live somewhere the browser can read (a snap-packaged Firefox
 * cannot open files under /tmp).
 */
import { spawn } from "node:child_process";
import path from "node:path";

const PORT = 4457;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = "file://" + path.resolve(path.dirname(new URL(import.meta.url).pathname), "layers.html");

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok  -", m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message?.slice(0, 160)}`);
  return json.value;
}

const gecko = spawn("geckodriver", ["--port", String(PORT)], { stdio: "ignore" });
gecko.on("error", () => fail("geckodriver is not installed; skipping the browser test"));

try {
  let session = null;
  for (let i = 0; i < 40 && !session; i++) {
    try {
      session = await call("POST", "/session", {
        capabilities: { alwaysMatch: { "moz:firefoxOptions": { args: ["-headless"] } } },
      });
    } catch { await sleep(250); }
  }
  if (!session) throw new Error("could not start a headless firefox session");
  const id = session.sessionId;
  const exec = (script) => call("POST", `/session/${id}/execute/sync`, { script, args: [] });

  await call("POST", `/session/${id}/url`, { url: PAGE });
  await call("POST", `/session/${id}/window/rect`, { width: 900, height: 800 });

  // Every coordinate is derived from live geometry: the real stylesheet pads
  // and centres the page, so nothing here may be hardcoded.
  const rects = JSON.parse(await exec(
    "return JSON.stringify([...document.querySelectorAll('#text span')].map(s => s.getBoundingClientRect().toJSON()));"));
  const page = JSON.parse(await exec(
    "return JSON.stringify(document.getElementById('page').getBoundingClientRect().toJSON());"));
  const mid = (r) => Math.round(r.top + r.height / 2);
  /** A point given in the overlay's 600x300 viewBox, in viewport coordinates. */
  const overlayPt = (x, y) => [
    Math.round(page.left + (x / 600) * page.width),
    Math.round(page.top + (y / 300) * page.height),
  ];
  const overText = [Math.round(rects[0].left + rects[0].width * 0.3), mid(rects[0])];

  async function drag(from, to) {
    await exec("window.getSelection().removeAllRanges();");
    await call("POST", `/session/${id}/actions`, {
      actions: [{
        type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: from[0], y: from[1] },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 30, x: Math.round((from[0] + to[0]) / 2), y: Math.round((from[1] + to[1]) / 2) },
          { type: "pointerMove", duration: 30, x: to[0], y: to[1] },
          { type: "pointerUp", button: 0 },
        ],
      }],
    });
    return {
      text: (await exec("return window.getSelection().toString();")).trim(),
      rectCount: await exec("const s = window.getSelection(); return s.rangeCount ? s.getRangeAt(0).getClientRects().length : 0;"),
    };
  }

  const hitOverText = await exec(
    `const e = document.elementFromPoint(${overText[0]}, ${overText[1]}); return (e.tagName + '.' + (e.className.baseVal ?? e.className)).toLowerCase();`);
  if (hitOverText.startsWith("span")) ok("the annotation overlay does not intercept the pointer over text");
  else fail(`the overlay swallows the pointer over text (hit ${hitOverText}); the highlight tool cannot select anything`);

  const across = await drag([rects[0].left + 4, mid(rects[0])], [Math.round(rects[1].left + rects[1].width * 0.6), mid(rects[1])]);
  if (across.text.length === 0) fail("dragging across two lines selected nothing");
  else if (across.rectCount < 2) fail(`a two-line selection reported ${across.rectCount} rectangle(s); highlights need one per line`);
  else ok(`a two-line drag selects text and reports ${across.rectCount} line rectangles`);

  const single = await drag([rects[0].left + 4, mid(rects[0])], [Math.round(rects[0].left + rects[0].width * 0.7), mid(rects[0])]);
  if (single.text.length > 0) ok("a single-line drag selects text");
  else fail("a single-line drag selected nothing");

  const annotPt = overlayPt(400, 235);
  const onAnnot = await exec(`const e = document.elementFromPoint(${annotPt[0]}, ${annotPt[1]}); return e.id || e.tagName;`);
  if (onAnnot === "hl") ok("an annotation stays clickable through the transparent overlay");
  else fail(`annotations are not clickable any more (hit ${onAnnot})`);

  await exec("document.getElementById('hitbg').setAttribute('pointer-events','all');");
  const onBackdrop = await exec(`const e = document.elementFromPoint(${overText[0]}, ${overText[1]}); return e.id || e.tagName;`);
  if (onBackdrop === "hitbg") ok("the brush backdrop takes the pointer when the brush turns it on");
  else fail(`the brush backdrop is unreachable (hit ${onBackdrop})`);

  const whileDrawing = await drag([rects[0].left + 4, mid(rects[0])], [Math.round(rects[1].left + rects[1].width * 0.6), mid(rects[1])]);
  if (whileDrawing.text.length === 0) ok("no stray text selection while the brush backdrop is active");
  else fail(`brush mode selected text: ${JSON.stringify(whileDrawing.text.slice(0, 40))}`);

  await call("DELETE", `/session/${id}`);
} catch (err) {
  fail(err.message);
} finally {
  gecko.kill();
}
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");

import { PDFDocument, StandardFonts } from "pdf-lib";
import { readAnnotations, writeAnnotations } from "../build-test/pdfio.js";

const fail = (msg) => { console.error("FAIL:", msg); process.exitCode = 1; };
const ok = (msg) => console.log("ok  -", msg);
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// A two-page PDF with some text and one pre-existing link annotation.
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (const label of ["Page one text", "Page two text"]) {
  const page = doc.addPage([400, 300]);
  page.drawText(label, { x: 40, y: 240, size: 18, font });
}
const first = doc.getPages()[0];
const ctx = doc.context;
const link = ctx.register(ctx.obj({
  Type: "Annot", Subtype: "Link", Rect: [10, 10, 60, 30], Border: [0, 0, 0],
}));
first.node.set(ctx.context ? "Annots" : (await import("pdf-lib")).PDFName.of("Annots"), ctx.obj([link]));
const original = (await doc.save()).buffer;

const annots = [
  { id: "obsann-ink-1", kind: "ink", page: 0, color: { r: 1, g: 0, b: 0 }, opacity: 1, contents: "", author: "Someone Else",
    width: 3, paths: [[{ x: 20, y: 20 }, { x: 60, y: 90 }, { x: 120, y: 40 }]] },
  { id: "obsann-hl-1", kind: "highlight", page: 0, color: { r: 1, g: 0.84, b: 0.04 }, opacity: 0.4,
    contents: "note attached to a highlight", author: "Someone Else",
    quads: [{ x1: 40, y1: 236, x2: 180, y2: 258 }, { x1: 40, y1: 210, x2: 150, y2: 232 }] },
  { id: "obsann-note-1", kind: "note", page: 1, color: { r: 0, g: 0.4, b: 1 }, opacity: 1,
    contents: "a region note", author: "Someone Else", rect: { x1: 30, y1: 100, x2: 200, y2: 160 } },
];

const saved = await writeAnnotations(original, annots);
ok(`wrote ${saved.length} bytes`);

const back = await readAnnotations(saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength));
if (back.pages.length !== 2) fail(`expected 2 pages, got ${back.pages.length}`);
else ok("page count preserved");

if (back.annots.length !== 3) fail(`expected 3 annots, got ${back.annots.length}: ${back.annots.map(a=>a.kind)}`);
else ok("all three annotations read back");

const byId = Object.fromEntries(back.annots.map((a) => [a.id, a]));

const ink = byId["obsann-ink-1"];
if (!ink || ink.kind !== "ink") fail("ink annotation missing");
else {
  if (ink.paths.length !== 1 || ink.paths[0].length !== 3) fail("ink path lost points");
  else if (!close(ink.paths[0][1].x, 60) || !close(ink.paths[0][1].y, 90)) fail("ink geometry drifted");
  else if (!close(ink.width, 3)) fail(`ink width drifted: ${ink.width}`);
  else if (!close(ink.color.r, 1) || !close(ink.color.g, 0)) fail("ink colour drifted");
  else ok("ink geometry, width and colour round-trip");
}

const hl = byId["obsann-hl-1"];
if (!hl || hl.kind !== "highlight") fail("highlight missing");
else if (hl.quads.length !== 2) fail(`expected 2 quads, got ${hl.quads.length}`);
else if (!close(hl.quads[0].x1, 40) || !close(hl.quads[0].y2, 258)) fail("quad geometry drifted");
else if (!close(hl.opacity, 0.4)) fail(`opacity drifted: ${hl.opacity}`);
else if (hl.contents !== "note attached to a highlight") fail("highlight note text lost");
else ok("highlight quads, opacity and note text round-trip");

const note = byId["obsann-note-1"];
if (!note || note.kind !== "note") fail("region note missing");
else if (note.page !== 1) fail(`note landed on page ${note.page}`);
else if (!close(note.rect.x2, 200) || !close(note.rect.y1, 100)) fail("note rect drifted");
else if (note.contents !== "a region note") fail("note text lost");
else ok("region note rect, page and text round-trip");

const wrongAuthor = back.annots.filter((a) => a.author !== "Someone Else");
if (wrongAuthor.length) fail(`author overwritten on ${wrongAuthor.length} annotation(s)`);
else ok("original annotation author preserved");

// Foreign annotations must survive untouched.
const reopened = await PDFDocument.load(saved, { ignoreEncryption: true });
const { PDFName, PDFArray, PDFDict } = await import("pdf-lib");
const arr = reopened.getPages()[0].node.lookupMaybe(PDFName.of("Annots"), PDFArray);
let links = 0;
for (let i = 0; i < arr.size(); i++) {
  const d = reopened.context.lookupMaybe(arr.get(i), PDFDict);
  if (d?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() === "/Link") links++;
}
if (links !== 1) fail(`the pre-existing link annotation was lost (found ${links})`);
else ok("pre-existing link annotation preserved");

// Appearance streams must exist so other readers render the annotations.
let withAp = 0;
for (const page of reopened.getPages()) {
  const a = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!a) continue;
  for (let i = 0; i < a.size(); i++) {
    const d = reopened.context.lookupMaybe(a.get(i), PDFDict);
    if (d?.lookupMaybe(PDFName.of("AP"), PDFDict)) withAp++;
  }
}
if (withAp !== 3) fail(`expected 3 appearance streams, found ${withAp}`);
else ok("appearance streams generated for every annotation");

// Repeated saves must not grow the file: each save restarts from the original.
let bytes = saved;
for (let i = 0; i < 5; i++) {
  bytes = await writeAnnotations(original, annots);
}
if (bytes.length !== saved.length) fail(`size drifted after 5 saves: ${saved.length} -> ${bytes.length}`);
else ok("repeated saves keep a stable file size");

// Editing then re-saving from the original must not orphan the old objects.
const edited = annots.slice(0, 2);
const smaller = await writeAnnotations(original, edited);
const backEdited = await readAnnotations(smaller.buffer.slice(smaller.byteOffset, smaller.byteOffset + smaller.byteLength));
if (backEdited.annots.length !== 2) fail(`delete did not persist: ${backEdited.annots.length} left`);
else if (smaller.length >= saved.length) fail(`deleting an annotation did not shrink the file (${smaller.length} vs ${saved.length})`);
else ok("deleting an annotation removes it and its objects from the file");

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");

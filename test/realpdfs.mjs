import fs from "node:fs/promises";
import path from "node:path";
import { readAnnotations, writeAnnotations } from "../build-test/pdfio.js";

const dir = process.argv[2];
const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".pdf")).slice(0, 8);
let failures = 0;

for (const name of files) {
  const buf = await fs.readFile(path.join(dir, name));
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const { annots, pages } = await readAnnotations(bytes.slice(0));
    const added = [{
      id: "obsann-test", kind: "highlight", page: 0,
      color: { r: 1, g: 0.84, b: 0.04 }, opacity: 0.4, contents: "hello",
      quads: [{ x1: 60, y1: pages[0].height - 120, x2: 260, y2: pages[0].height - 100 }],
    }];
    const out = await writeAnnotations(bytes.slice(0), [...annots, ...added]);
    const back = await readAnnotations(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    const found = back.annots.find((a) => a.id === "obsann-test");
    const okCount = back.annots.length === annots.length + 1;
    console.log(
      `${found && okCount ? "ok  -" : "FAIL-"} ${name.slice(0, 46).padEnd(46)} ` +
      `pages=${String(pages.length).padStart(3)} existing=${String(annots.length).padStart(3)} ` +
      `after=${String(back.annots.length).padStart(3)} ${(buf.length/1024).toFixed(0)}KB -> ${(out.length/1024).toFixed(0)}KB`
    );
    if (!found || !okCount) failures++;
  } catch (err) {
    console.log(`FAIL- ${name}: ${err.message}`);
    failures++;
  }
}
console.log(failures ? `\n${failures} file(s) failed` : "\nall real PDFs round-tripped");
process.exitCode = failures ? 1 : 0;

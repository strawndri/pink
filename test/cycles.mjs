import fs from "node:fs/promises";
import { readAnnotations, writeAnnotations } from "../build-test/pdfio.js";

const file = process.argv[2];
const buf = await fs.readFile(file);
let bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const start = bytes.byteLength;
console.log(`start ${(start / 1024).toFixed(0)}KB`);

// Each cycle = open the file, keep its annotations, add one, save.
for (let i = 1; i <= 6; i++) {
  const { annots, pages } = await readAnnotations(bytes.slice(0));
  annots.push({
    id: `obsann-cycle-${i}`, kind: "ink", page: 0,
    color: { r: 0.9, g: 0.1, b: 0.1 }, opacity: 1, contents: "", width: 2,
    paths: [[{ x: 50, y: 50 + i * 10 }, { x: 250, y: 60 + i * 10 }]],
  });
  const out = await writeAnnotations(bytes.slice(0), annots);
  bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  console.log(`cycle ${i}: ${annots.length} annots, ${(bytes.byteLength / 1024).toFixed(0)}KB ` +
    `(${(((bytes.byteLength - start) / start) * 100).toFixed(1)}% vs original)`);
}
const final = await readAnnotations(bytes.slice(0));
console.log(`final read-back: ${final.annots.length} annotations`);

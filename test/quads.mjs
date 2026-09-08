import { mergeLineQuads, dropContainers } from "../build-test/types.js";

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok  -", m);
const r = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const show = (q) => `[${q.x1},${q.y1} ${q.x2},${q.y2}]`;

// pdf.js emits one span per text run, so a single visual line arrives as
// several abutting rectangles. A highlight should be one bar per line.
{
  const line1 = [r(50, 700, 90, 712), r(91, 700, 140, 712), r(141, 700, 200, 712)];
  const line2 = [r(50, 686, 120, 698), r(121, 686, 180, 698)];
  const out = mergeLineQuads([...line1, ...line2]);
  if (out.length !== 2) fail(`expected 2 line bars, got ${out.length}: ${out.map(show).join(" ")}`);
  else if (out[0].x1 !== 50 || out[0].x2 !== 200) fail(`first line not merged: ${show(out[0])}`);
  else if (out[1].x1 !== 50 || out[1].x2 !== 180) fail(`second line not merged: ${show(out[1])}`);
  else ok("spans on the same line merge into one bar per line");
}

// Lines must stay separate even when their spans are listed out of order.
{
  const out = mergeLineQuads([r(50, 686, 120, 698), r(141, 700, 200, 712), r(50, 700, 140, 712)]);
  if (out.length !== 2) fail(`out-of-order input gave ${out.length} bars`);
  else if (!(out[0].y1 === 700 && out[1].y1 === 686)) fail("bars not ordered top-to-bottom");
  else ok("input order does not matter; bars come out top-to-bottom");
}

// Two columns on the same baseline must not be joined across the gutter.
{
  const out = mergeLineQuads([r(50, 700, 200, 712), r(320, 700, 470, 712)]);
  if (out.length !== 2) fail(`columns merged across the gutter: ${out.map(show).join(" ")}`);
  else ok("a wide gap on the same line stays two separate bars");
}

// Slightly different span heights on one line still count as one line.
{
  const out = mergeLineQuads([r(50, 700, 90, 712), r(91, 702, 140, 711)]);
  if (out.length !== 1) fail(`ragged span heights split the line: ${out.map(show).join(" ")}`);
  else if (out[0].y1 !== 700 || out[0].y2 !== 712) fail(`merged bar lost its extent: ${show(out[0])}`);
  else ok("spans of slightly different height merge into one bar");
}

// A selection of a single word is left alone.
{
  const out = mergeLineQuads([r(50, 700, 90, 712)]);
  if (out.length !== 1 || out[0].x2 !== 90) fail("single rect was altered");
  else ok("a one-word selection passes through unchanged");
}

// A wrapper rect covering the whole block must not survive: keeping it is what
// turns a two-line selection into one big box.
{
  const block = r(50, 686, 200, 712);
  const lines = [r(50, 700, 200, 712), r(50, 686, 180, 698)];
  const out = dropContainers([block, ...lines]);
  if (out.length !== 2) fail(`wrapper rect not dropped: ${out.map(show).join(" ")}`);
  else if (out.some((q) => q.y1 === 686 && q.y2 === 712)) fail("the block rect survived");
  else ok("a block-sized wrapper rect is discarded, keeping the line rects");

  const bars = mergeLineQuads(dropContainers([block, ...lines]));
  if (bars.length !== 2) fail(`full pipeline produced ${bars.length} bars, not 2`);
  else if (bars.some((b) => b.y2 - b.y1 > 14)) fail(`a bar is block-height: ${bars.map(show).join(" ")}`);
  else ok("wrapper + lines through the full pipeline gives one bar per line");
}

// Identical duplicate rects must not annihilate each other.
{
  const out = dropContainers([r(50, 700, 90, 712), r(50, 700, 90, 712)]);
  if (out.length !== 2) fail(`duplicates were dropped: ${out.length} left`);
  else if (mergeLineQuads(out).length !== 1) fail("duplicates did not merge back into one bar");
  else ok("duplicate rects survive the filter and merge into a single bar");
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");

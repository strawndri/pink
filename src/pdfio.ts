import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFHexString,
	PDFName,
	PDFNumber,
	PDFRef,
	PDFString,
} from "pdf-lib";
import type { PDFContext, PDFPage } from "pdf-lib";
import {
	Annot,
	InkAnnot,
	HighlightAnnot,
	NoteAnnot,
	Pt,
	RGB,
	Rect,
	annotBounds,
	newAnnotId,
	noteMarkerRect,
} from "./types";

/** Annotation subtypes this plugin owns: they are parsed on load and fully
 * rewritten on save. Every other subtype (links, form widgets, stamps...) is
 * left exactly as it was found. */
const MANAGED_SUBTYPES = new Set(["Ink", "Highlight", "Square", "Text"]);

/** Used only when an annotation carries no author of its own. */
export const DEFAULT_AUTHOR = "Obsidian";

export interface PageGeometry {
	width: number;
	height: number;
}

export interface LoadedPdf {
	annots: Annot[];
	pages: PageGeometry[];
}

/* ------------------------------------------------------------------ read */

export async function readAnnotations(bytes: ArrayBuffer): Promise<LoadedPdf> {
	const doc = await PDFDocument.load(bytes, {
		ignoreEncryption: true,
		updateMetadata: false,
	});
	const annots: Annot[] = [];
	const pages: PageGeometry[] = [];

	doc.getPages().forEach((page, pageIndex) => {
		const { width, height } = page.getSize();
		pages.push({ width, height });
		for (const dict of annotDicts(page)) {
			const parsed = parseAnnot(dict, pageIndex);
			if (parsed) annots.push(parsed);
		}
	});

	return { annots, pages };
}

function annotDicts(page: PDFPage): PDFDict[] {
	const ctx = page.node.context;
	const array = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
	if (!array) return [];
	const out: PDFDict[] = [];
	for (let i = 0; i < array.size(); i++) {
		const dict = ctx.lookupMaybe(array.get(i), PDFDict);
		if (dict) out.push(dict);
	}
	return out;
}

function subtypeOf(dict: PDFDict): string {
	const name = dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
	return name ? name.asString().replace(/^\//, "") : "";
}

function parseAnnot(dict: PDFDict, page: number): Annot | null {
	const subtype = subtypeOf(dict);
	if (!MANAGED_SUBTYPES.has(subtype)) return null;

	const id = readText(dict, "NM") || newAnnotId();
	const color = readColor(dict) ?? { r: 1, g: 0.85, b: 0 };
	const opacity = readNumber(dict, "CA") ?? 1;
	const contents = readText(dict, "Contents") ?? "";
	const author = readText(dict, "T") || DEFAULT_AUTHOR;
	const base = { id, page, color, opacity, contents, author };

	if (subtype === "Ink") {
		const paths = readInkList(dict);
		if (paths.length === 0) return null;
		const ink: InkAnnot = { ...base, kind: "ink", width: readInkWidth(dict), paths };
		return ink;
	}

	if (subtype === "Highlight") {
		const quads = readQuadPoints(dict) ?? rectAsQuads(readRect(dict));
		if (!quads || quads.length === 0) return null;
		const hl: HighlightAnnot = { ...base, kind: "highlight", quads };
		return hl;
	}

	// Square (our region notes) and Text (sticky notes from other readers).
	const rect = readRect(dict);
	if (!rect) return null;
	const note: NoteAnnot = { ...base, kind: "note", rect };
	return note;
}

function readText(dict: PDFDict, key: string): string {
	const value = dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
	return value ? value.decodeText() : "";
}

function readNumber(dict: PDFDict, key: string): number | null {
	const value = dict.lookupMaybe(PDFName.of(key), PDFNumber);
	return value ? value.asNumber() : null;
}

function readColor(dict: PDFDict): RGB | null {
	const array = dict.lookupMaybe(PDFName.of("C"), PDFArray);
	if (!array) return null;
	const nums: number[] = [];
	for (let i = 0; i < array.size(); i++) {
		const n = array.lookupMaybe(i, PDFNumber);
		nums.push(n ? n.asNumber() : 0);
	}
	if (nums.length === 1) return { r: nums[0], g: nums[0], b: nums[0] };
	if (nums.length === 3) return { r: nums[0], g: nums[1], b: nums[2] };
	if (nums.length === 4) {
		const [c, m, y, k] = nums;
		return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
	}
	return null;
}

function readRect(dict: PDFDict): Rect | null {
	const array = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
	if (!array || array.size() < 4) return null;
	const v = [0, 1, 2, 3].map((i) => {
		const n = array.lookupMaybe(i, PDFNumber);
		return n ? n.asNumber() : 0;
	});
	return {
		x1: Math.min(v[0], v[2]),
		y1: Math.min(v[1], v[3]),
		x2: Math.max(v[0], v[2]),
		y2: Math.max(v[1], v[3]),
	};
}

function rectAsQuads(rect: Rect | null): Rect[] | null {
	return rect ? [rect] : null;
}

function readInkWidth(dict: PDFDict): number {
	const bs = dict.lookupMaybe(PDFName.of("BS"), PDFDict);
	const w = bs ? readNumber(bs, "W") : null;
	return w && w > 0 ? w : 1;
}

function readInkList(dict: PDFDict): Pt[][] {
	const list = dict.lookupMaybe(PDFName.of("InkList"), PDFArray);
	if (!list) return [];
	const paths: Pt[][] = [];
	for (let i = 0; i < list.size(); i++) {
		const sub = list.lookupMaybe(i, PDFArray);
		if (!sub) continue;
		const pts: Pt[] = [];
		for (let j = 0; j + 1 < sub.size(); j += 2) {
			const x = sub.lookupMaybe(j, PDFNumber);
			const y = sub.lookupMaybe(j + 1, PDFNumber);
			if (x && y) pts.push({ x: x.asNumber(), y: y.asNumber() });
		}
		if (pts.length > 0) paths.push(pts);
	}
	return paths;
}

/** QuadPoints are stored as upper-left, upper-right, lower-left, lower-right. */
function readQuadPoints(dict: PDFDict): Rect[] | null {
	const array = dict.lookupMaybe(PDFName.of("QuadPoints"), PDFArray);
	if (!array || array.size() < 8) return null;
	const nums: number[] = [];
	for (let i = 0; i < array.size(); i++) {
		const n = array.lookupMaybe(i, PDFNumber);
		nums.push(n ? n.asNumber() : 0);
	}
	const quads: Rect[] = [];
	for (let i = 0; i + 7 < nums.length; i += 8) {
		const xs = [nums[i], nums[i + 2], nums[i + 4], nums[i + 6]];
		const ys = [nums[i + 1], nums[i + 3], nums[i + 5], nums[i + 7]];
		quads.push({
			x1: Math.min(...xs),
			y1: Math.min(...ys),
			x2: Math.max(...xs),
			y2: Math.max(...ys),
		});
	}
	return quads;
}

/* ----------------------------------------------------------------- write */

/** Rewrites the managed annotations of `originalBytes` from `annots` and
 * returns the new file. The original bytes are always the starting point, so
 * repeated saves never stack edits on top of each other. */
export async function writeAnnotations(
	originalBytes: ArrayBuffer,
	annots: Annot[],
): Promise<Uint8Array> {
	const doc = await PDFDocument.load(originalBytes, {
		ignoreEncryption: true,
		updateMetadata: false,
	});
	const ctx = doc.context;
	const pages = doc.getPages();

	pages.forEach((page, pageIndex) => {
		const kept = dropManagedAnnots(page, ctx);
		for (const annot of annots.filter((a) => a.page === pageIndex)) {
			kept.push(buildAnnot(ctx, annot));
		}
		if (kept.length === 0) {
			page.node.delete(PDFName.of("Annots"));
		} else {
			page.node.set(PDFName.of("Annots"), ctx.obj(kept));
		}
	});

	return doc.save({ useObjectStreams: false });
}

/** Removes (and garbage-collects) every managed annotation on the page,
 * returning the refs of the ones we must preserve untouched. */
function dropManagedAnnots(page: PDFPage, ctx: PDFContext): PDFRef[] {
	const array = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
	if (!array) return [];
	const keep: PDFRef[] = [];
	for (let i = 0; i < array.size(); i++) {
		const entry = array.get(i);
		const dict = ctx.lookupMaybe(entry, PDFDict);
		if (dict && MANAGED_SUBTYPES.has(subtypeOf(dict))) {
			releaseAnnot(ctx, entry, dict);
			continue;
		}
		if (entry instanceof PDFRef) keep.push(entry);
	}
	return keep;
}

/** Frees an annotation object and its appearance stream so that saving the
 * same file repeatedly does not grow it without bound. */
function releaseAnnot(ctx: PDFContext, entry: unknown, dict: PDFDict): void {
	const ap = dict.lookupMaybe(PDFName.of("AP"), PDFDict);
	if (ap) {
		const n = ap.get(PDFName.of("N"));
		if (n instanceof PDFRef) ctx.delete(n);
	}
	const popup = dict.get(PDFName.of("Popup"));
	if (popup instanceof PDFRef) ctx.delete(popup);
	if (entry instanceof PDFRef) ctx.delete(entry);
}

function buildAnnot(ctx: PDFContext, annot: Annot): PDFRef {
	const rect = annotBounds(annot);
	const dict = ctx.obj({
		Type: "Annot",
		Subtype: annot.kind === "ink" ? "Ink" : annot.kind === "highlight" ? "Highlight" : "Square",
		Rect: [rect.x1, rect.y1, rect.x2, rect.y2],
		C: [annot.color.r, annot.color.g, annot.color.b],
		CA: annot.opacity,
		// Print (bit 3); annotations are visible and printable but not locked.
		F: 4,
		NM: PDFString.of(annot.id),
		Contents: PDFString.of(annot.contents),
		T: PDFString.of(annot.author || DEFAULT_AUTHOR),
		M: PDFString.of(pdfDate(new Date())),
	});

	if (annot.kind === "ink") {
		dict.set(PDFName.of("InkList"), ctx.obj(annot.paths.map((p) => p.flatMap((q) => [q.x, q.y]))));
		dict.set(PDFName.of("BS"), ctx.obj({ Type: "Border", W: annot.width, S: "S" }));
	} else if (annot.kind === "highlight") {
		dict.set(PDFName.of("QuadPoints"), ctx.obj(annot.quads.flatMap(quadPoints)));
	} else {
		dict.set(PDFName.of("IC"), ctx.obj([]));
		// The appearance stream is the whole look; a reader drawing its own border
		// on top would put a second box around the marker.
		dict.set(PDFName.of("BS"), ctx.obj({ Type: "Border", W: 0, S: "S" }));
	}

	dict.set(PDFName.of("AP"), ctx.obj({ N: appearanceStream(ctx, annot, rect) }));
	return ctx.register(dict);
}

/** Upper-left, upper-right, lower-left, lower-right, per the PDF spec. */
function quadPoints(q: Rect): number[] {
	return [q.x1, q.y2, q.x2, q.y2, q.x1, q.y1, q.x2, q.y1];
}

/** Builds the appearance stream so other PDF readers show the annotation the
 * same way this plugin does. Drawing happens in page coordinates and the form
 * BBox equals /Rect, which makes the annotation transform the identity. */
function appearanceStream(ctx: PDFContext, annot: Annot, rect: Rect): PDFRef {
	const { r, g, b } = annot.color;
	const ops: string[] = ["q", "/GS0 gs"];

	if (annot.kind === "ink") {
		ops.push(`${n(r)} ${n(g)} ${n(b)} RG`, `${n(annot.width)} w`, "1 J", "1 j");
		for (const path of annot.paths) {
			if (path.length === 0) continue;
			ops.push(`${n(path[0].x)} ${n(path[0].y)} m`);
			for (const p of path.slice(1)) ops.push(`${n(p.x)} ${n(p.y)} l`);
			// A single-point stroke would be invisible with a butt cap; the round
			// cap set above turns this degenerate segment into a dot.
			if (path.length === 1) ops.push(`${n(path[0].x)} ${n(path[0].y)} l`);
			ops.push("S");
		}
	} else if (annot.kind === "highlight") {
		ops.push(`${n(r)} ${n(g)} ${n(b)} rg`);
		for (const q of annot.quads) {
			ops.push(`${n(q.x1)} ${n(q.y1)} ${n(q.x2 - q.x1)} ${n(q.y2 - q.y1)} re`);
		}
		ops.push("f");
	} else {
		const m = noteMarkerRect(rect);
		ops.push(
			`${n(r)} ${n(g)} ${n(b)} rg`,
			`${n(m.x1)} ${n(m.y1)} ${n(m.x2 - m.x1)} ${n(m.y2 - m.y1)} re`,
			"f",
		);
	}

	ops.push("Q");

	return ctx.register(
		ctx.flateStream(ops.join("\n"), {
			Type: "XObject",
			Subtype: "Form",
			FormType: 1,
			BBox: [rect.x1, rect.y1, rect.x2, rect.y2],
			Resources: {
				ExtGState: {
					GS0: {
						Type: "ExtGState",
						CA: annot.opacity,
						ca: annot.opacity,
						// Multiply keeps the underlying text readable through a highlight.
						BM: annot.kind === "highlight" ? "Multiply" : "Normal",
					},
				},
			},
		}),
	);
}

function n(value: number): string {
	return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
}

function pdfDate(date: Date): string {
	const p = (v: number) => String(v).padStart(2, "0");
	return (
		`D:${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
		`${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
	);
}

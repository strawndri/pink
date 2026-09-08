/** Geometry and annotation model.
 *
 * All coordinates are stored in PDF user space (points, origin at the
 * bottom-left of the page) so that they survive zooming and round-trip
 * through the PDF file unchanged. */

export interface Pt {
	x: number;
	y: number;
}

export interface Rect {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface RGB {
	r: number;
	g: number;
	b: number;
}

export type AnnotKind = "ink" | "highlight" | "note";

interface AnnotBase {
	/** Stable id, also written to the PDF as the annotation's /NM entry. */
	id: string;
	kind: AnnotKind;
	/** 0-based page index. */
	page: number;
	color: RGB;
	/** 0..1 */
	opacity: number;
	/** Note text attached to the annotation. Empty string when there is none. */
	contents: string;
	/** PDF /T entry. Preserved for annotations made in other readers. */
	author: string;
}

/** Freehand brush stroke, stored as one or more polylines. */
export interface InkAnnot extends AnnotBase {
	kind: "ink";
	width: number;
	paths: Pt[][];
}

/** Coloured highlight over one or more rectangular regions. */
export interface HighlightAnnot extends AnnotBase {
	kind: "highlight";
	quads: Rect[];
}

/** A note anchored to a rectangular region of the page. */
export interface NoteAnnot extends AnnotBase {
	kind: "note";
	rect: Rect;
}

export type Annot = InkAnnot | HighlightAnnot | NoteAnnot;

export function normRect(a: Pt, b: Pt): Rect {
	return {
		x1: Math.min(a.x, b.x),
		y1: Math.min(a.y, b.y),
		x2: Math.max(a.x, b.x),
		y2: Math.max(a.y, b.y),
	};
}

export function rectContains(r: Rect, p: Pt, pad = 0): boolean {
	return p.x >= r.x1 - pad && p.x <= r.x2 + pad && p.y >= r.y1 - pad && p.y <= r.y2 + pad;
}

/** Axis-aligned bounding box of an annotation, in PDF user space. */
export function annotBounds(a: Annot): Rect {
	if (a.kind === "note") return a.rect;
	if (a.kind === "highlight") return unionRects(a.quads);
	const pts = a.paths.flat();
	if (pts.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 };
	const half = a.width / 2;
	const xs = pts.map((p) => p.x);
	const ys = pts.map((p) => p.y);
	return {
		x1: Math.min(...xs) - half,
		y1: Math.min(...ys) - half,
		x2: Math.max(...xs) + half,
		y2: Math.max(...ys) + half,
	};
}

/** Side of the square that stands in for a note, in PDF points. */
export const NOTE_MARKER = 12;

/** A note is drawn as a single small square pinned to the start (top-left) of
 * the region it is anchored to, never larger than that region. The region
 * itself stays unpainted: it is the hover target, not something to box in. */
export function noteMarkerRect(rect: Rect): Rect {
	const side =
		Math.min(NOTE_MARKER, rect.x2 - rect.x1, rect.y2 - rect.y1) || NOTE_MARKER;
	return { x1: rect.x1, y1: rect.y2 - side, x2: rect.x1 + side, y2: rect.y2 };
}

export function unionRects(rects: Rect[]): Rect {
	if (rects.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 };
	return rects.reduce((acc, r) => ({
		x1: Math.min(acc.x1, r.x1),
		y1: Math.min(acc.y1, r.y1),
		x2: Math.max(acc.x2, r.x2),
		y2: Math.max(acc.y2, r.y2),
	}));
}

export function hexToRgb(hex: string): RGB {
	const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
	if (!m) return { r: 1, g: 0.85, b: 0 };
	return {
		r: parseInt(m[1], 16) / 255,
		g: parseInt(m[2], 16) / 255,
		b: parseInt(m[3], 16) / 255,
	};
}

export function rgbToHex(c: RGB): string {
	const to = (v: number) =>
		Math.round(Math.min(1, Math.max(0, v)) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

export function rgbToCss(c: RGB, alpha = 1): string {
	const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
	return `rgba(${to(c.r)}, ${to(c.g)}, ${to(c.b)}, ${alpha})`;
}

let counter = 0;

/** Ids are prefixed so we can tell our annotations apart from foreign ones. */
export function newAnnotId(): string {
	counter += 1;
	return `obsann-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function cloneAnnots(annots: Annot[]): Annot[] {
	return annots.map((a) => {
		if (a.kind === "ink") return { ...a, color: { ...a.color }, paths: a.paths.map((p) => p.map((q) => ({ ...q }))) };
		if (a.kind === "highlight") return { ...a, color: { ...a.color }, quads: a.quads.map((q) => ({ ...q })) };
		return { ...a, color: { ...a.color }, rect: { ...a.rect } };
	});
}

/** A text selection can report both the individual line rectangles and a
 * wrapper rectangle around the whole block. Keeping the wrapper would turn the
 * highlight into one big box, so any rectangle that strictly contains another
 * is discarded and only the leaves are kept. */
export function dropContainers(quads: Rect[]): Rect[] {
	const area = (q: Rect) => (q.x2 - q.x1) * (q.y2 - q.y1);
	const contains = (outer: Rect, inner: Rect) =>
		outer.x1 <= inner.x1 + 0.5 &&
		outer.y1 <= inner.y1 + 0.5 &&
		outer.x2 >= inner.x2 - 0.5 &&
		outer.y2 >= inner.y2 - 0.5;
	return quads.filter(
		(quad, i) =>
			!quads.some((other, j) => j !== i && contains(quad, other) && area(quad) > area(other) + 0.5),
	);
}

/** Horizontal gap, in points, still considered part of the same run of text. */
const LINE_GAP = 3;

/** Collapses the per-span rectangles a text selection produces into one bar per
 * line, which is what a PDF reader's highlight looks like. */
export function mergeLineQuads(quads: Rect[]): Rect[] {
	if (quads.length < 2) return quads;
	const lines: Rect[][] = [];
	for (const quad of [...quads].sort((a, b) => b.y2 - a.y2 || a.x1 - b.x1)) {
		const line = lines.find(([ref]) => {
			const overlap = Math.min(ref.y2, quad.y2) - Math.max(ref.y1, quad.y1);
			return overlap > 0.5 * Math.min(ref.y2 - ref.y1, quad.y2 - quad.y1);
		});
		if (line) line.push(quad);
		else lines.push([quad]);
	}

	const merged: Rect[] = [];
	for (const line of lines) {
		line.sort((a, b) => a.x1 - b.x1);
		let run = { ...line[0] };
		for (const quad of line.slice(1)) {
			if (quad.x1 <= run.x2 + LINE_GAP) {
				run.x2 = Math.max(run.x2, quad.x2);
				run.y1 = Math.min(run.y1, quad.y1);
				run.y2 = Math.max(run.y2, quad.y2);
			} else {
				merged.push(run);
				run = { ...quad };
			}
		}
		merged.push(run);
	}
	return merged;
}

import { loadPdfJs } from "obsidian";
import type { Pt } from "./types";

/** Minimal shape of the pdf.js page viewport we rely on. */
export interface Viewport {
	width: number;
	height: number;
	scale: number;
	/** [a, b, c, d, e, f] mapping PDF user space to viewport pixels. */
	transform: number[];
}

let pdfjsPromise: Promise<any> | null = null;

/** Obsidian ships its own copy of pdf.js; reuse it instead of bundling one. */
export function getPdfjs(): Promise<any> {
	if (!pdfjsPromise) pdfjsPromise = loadPdfJs();
	return pdfjsPromise;
}

export function toViewportPt(vp: Viewport, x: number, y: number): Pt {
	const t = vp.transform;
	return { x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5] };
}

export function toPdfPt(vp: Viewport, x: number, y: number): Pt {
	const t = vp.transform;
	const det = t[0] * t[3] - t[1] * t[2];
	if (det === 0) return { x, y };
	const px = x - t[4];
	const py = y - t[5];
	return { x: (px * t[3] - py * t[2]) / det, y: (py * t[0] - px * t[1]) / det };
}

/** Renders the selectable text layer over a page.
 *
 * pdf.js changed this API between major versions and Obsidian upgrades its
 * bundled copy independently of this plugin, so both shapes are supported and
 * a failure is non-fatal.
 *
 * Returns how many text spans were produced, or -1 if the layer could not be
 * rendered at all. Zero spans means the page carries no selectable text, which
 * the highlight tool needs to report differently from a broken text layer. */
export async function renderTextLayer(
	pdfjs: any,
	page: any,
	viewport: Viewport,
	container: HTMLElement,
): Promise<number> {
	container.empty();
	// pdf.js sizes the layer with calc()/round() over these variables. They are
	// normally provided by its viewer stylesheet, which does not apply here.
	container.style.setProperty("--scale-factor", String(viewport.scale));
	container.style.setProperty("--total-scale-factor", String(viewport.scale));
	container.style.setProperty("--user-unit", "1");
	container.style.setProperty("--scale-round-x", "1px");
	container.style.setProperty("--scale-round-y", "1px");

	try {
		const textContent = await page.getTextContent();

		if (typeof pdfjs.TextLayer === "function") {
			const layer = new pdfjs.TextLayer({ textContentSource: textContent, container, viewport });
			await layer.render();
			return countSpans(container);
		}

		if (typeof pdfjs.renderTextLayer === "function") {
			const task = pdfjs.renderTextLayer({
				textContentSource: textContent,
				textContent,
				container,
				viewport,
				textDivs: [],
			});
			await (task && task.promise ? task.promise : task);
			return countSpans(container);
		}
	} catch (err) {
		console.warn("Pink: text layer unavailable", err);
	}
	return -1;
}

function countSpans(container: HTMLElement): number {
	return container.querySelectorAll("span").length;
}

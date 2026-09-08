import { FileView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PinkPlugin from "./main";
import { History } from "./history";
import { NoteModal } from "./modals";
import { Viewport, getPdfjs, renderTextLayer, toPdfPt, toViewportPt } from "./pdfjs";
import { DEFAULT_AUTHOR, readAnnotations, writeAnnotations } from "./pdfio";
import type { ToolName } from "./settings";
import {
	Annot,
	Pt,
	Rect,
	annotBounds,
	cloneAnnots,
	hexToRgb,
	NOTE_MARKER,
	newAnnotId,
	noteMarkerRect,
	dropContainers,
	mergeLineQuads,
	normRect,
	rectContains,
	rgbToCss,
	unionRects,
} from "./types";

export const VIEW_TYPE_PINK = "pink-view";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Minimum distance, in PDF points, between two recorded brush samples. */
const BRUSH_MIN_STEP = 0.6;
/** Pointer travel below this (in CSS pixels) counts as a click, not a drag. */
const CLICK_SLOP = 4;
/** Extra stroke width, in points, that makes thin ink easier to click. */
const HIT_STROKE = 12;
/** Side of the corner tab marking an ink stroke or highlight that has a note. */
const NOTE_TAB = 9;
/** pdf.js AnnotationMode.DISABLE.
 *
 * The overlay is the only thing that should draw the annotations this plugin
 * manages. Left at its default, pdf.js also bakes them into the canvas from
 * their appearance streams, so a saved annotation ends up painted twice and,
 * worse, the canvas copy survives a delete until the file is reopened. */
const ANNOTATIONS_OFF = 0;

/** One text run from pdf.js, placed in PDF user space. */
interface TextBox {
	/** Offset of this run inside the page's concatenated text. */
	start: number;
	len: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

interface PageText {
	/** Lowercased, so searching never has to case-fold again. */
	text: string;
	boxes: TextBox[];
}

interface OutlineEntry {
	title: string;
	/** Nesting level, 0 for a top-level section. */
	depth: number;
	/** 0-based page, or -1 when the destination could not be resolved. */
	page: number;
}

interface SearchMatch {
	page: number;
	/** One rect per text run the match spans, so a match that wraps across a
	 * line is drawn as two bars rather than one tall box. */
	rects: Rect[];
}

interface PageLayer {
	index: number;
	container: HTMLElement;
	canvas: HTMLCanvasElement;
	textEl: HTMLElement;
	overlay: SVGSVGElement;
	hitBg: SVGRectElement;
	annotGroup: SVGGElement;
	searchGroup: SVGGElement;
	draftGroup: SVGGElement;
	page: any;
	viewport1: Viewport;
	rendered: boolean;
	renderTask: any;
	token: number;
	/** Text spans rendered on this page: -1 unknown, 0 no selectable text. */
	textSpans: number;
}

const TOOLS: { tool: ToolName; icon: string; label: string; key: string }[] = [
	{ tool: "select", icon: "mouse-pointer-2", label: "Select", key: "V" },
	{ tool: "text", icon: "text-cursor", label: "Select text to copy", key: "T" },
	{ tool: "brush", icon: "pencil", label: "Brush", key: "B" },
	{ tool: "highlight", icon: "highlighter", label: "Highlight", key: "H" },
	{ tool: "note", icon: "sticky-note", label: "Note", key: "N" },
];

export class PinkView extends FileView {
	allowNoFile = false;

	private toolbarEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private pagesEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private toolButtons: Partial<Record<ToolName, HTMLElement>> = {};
	private undoBtn!: HTMLButtonElement;
	private redoBtn!: HTMLButtonElement;
	private deleteBtn!: HTMLButtonElement;
	private noteBtn!: HTMLButtonElement;
	private saveBtn!: HTMLButtonElement;
	private zoomLabel!: HTMLElement;
	private pageInput!: HTMLInputElement;
	private pageTotal!: HTMLElement;
	/** Flattened table of contents, or null until the PDF has been asked. */
	private outline: OutlineEntry[] | null = null;
	private swatchEls: HTMLElement[] = [];

	private bytes: ArrayBuffer | null = null;
	private pdf: any = null;
	private layers: PageLayer[] = [];
	private observer: IntersectionObserver | null = null;

	private annots: Annot[] = [];
	private readonly history = new History<Annot[]>(200);
	private readonly selection = new Set<string>();

	private tool: ToolName;
	private color: string;
	private brushWidth: number;
	private highlightOpacity: number;
	private scale: number;

	private tooltipEl!: HTMLElement;
	private tooltipInput!: HTMLTextAreaElement;
	private hoverId: string | null = null;
	private hoverLayer: PageLayer | null = null;
	private hoverFrame = 0;
	private hoverHide = 0;
	private dragging = false;
	private hintShown = false;

	private searchEl!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private searchCount!: HTMLElement;
	/** Text of each page, lazily built the first time a search runs. */
	private searchPages: (PageText | null)[] = [];
	private searchMatches: SearchMatch[] = [];
	private searchAt = -1;

	private dirty = false;
	private saving = false;
	private saveTimer = 0;
	/** Set while a save we started is still echoing back through the vault. */
	private selfWrite = false;
	private hasTextLayer = true;
	private currentPage = 0;
	private loadToken = 0;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: PinkPlugin) {
		super(leaf);
		const s = plugin.settings;
		this.tool = s.defaultTool;
		this.color = s.highlightColor;
		this.brushWidth = s.brushWidth;
		this.highlightOpacity = s.highlightOpacity;
		this.scale = s.defaultZoom;
	}

	getViewType(): string {
		return VIEW_TYPE_PINK;
	}

	getIcon(): string {
		return "highlighter";
	}

	getDisplayText(): string {
		return this.file ? this.file.basename : "Pink";
	}

	/* ------------------------------------------------------------ lifecycle */

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("pink-root");
		this.toolbarEl = this.contentEl.createDiv({ cls: "pink-toolbar" });
		this.buildSearchBar();
		this.scrollEl = this.contentEl.createDiv({ cls: "pink-scroll" });
		this.pagesEl = this.scrollEl.createDiv({ cls: "pink-pages" });
		this.statusEl = this.contentEl.createDiv({ cls: "pink-status" });
		this.tooltipEl = document.body.createDiv({ cls: "pink-tooltip" });
		this.tooltipInput = this.tooltipEl.createEl("textarea", {
			cls: "pink-tooltip-input",
			attr: { placeholder: "Note", spellcheck: "false" },
		});
		// Moving the pointer off the annotation and onto the balloon must not
		// close it, or the note inside could never be reached.
		this.registerDomEvent(this.tooltipEl, "pointerenter", () => this.cancelHide());
		this.registerDomEvent(this.tooltipEl, "pointerleave", () => this.scheduleHide());
		this.registerDomEvent(this.tooltipInput, "input", () => this.growTooltip());
		this.registerDomEvent(this.tooltipInput, "blur", () => this.commitTooltipEdit());
		this.registerDomEvent(this.tooltipInput, "keydown", (evt) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			this.tooltipInput.blur();
			this.hideTooltip();
		});

		this.buildToolbar();
		this.registerDomEvent(document, "keydown", (evt) => {
			if (this.app.workspace.getActiveViewOfType(PinkView) !== this) return;
			if (document.body.hasClass("modal-open")) return;
			const target = evt.target as HTMLElement | null;
			if (target?.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
			this.onKeyDown(evt);
		});
		this.registerDomEvent(this.scrollEl, "scroll", () => {
			// The balloon is pinned to a spot on the page, not to the window.
			this.positionTooltip();
			this.updateCurrentPage();
		});
		this.contentEl.tabIndex = -1;

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				// Our own writes echo back as a modify event; selfWrite covers that
				// window. Anything else means the file changed underneath us.
				if (file !== this.file || this.selfWrite || this.saving) return;
				void this.reload();
			}),
		);
	}

	async onLoadFile(file: TFile): Promise<void> {
		const token = ++this.loadToken;
		this.teardownPages();
		this.history.clear();
		this.selection.clear();
		this.dirty = false;
		this.hintShown = false;
		this.searchPages = [];
		this.searchMatches = [];
		this.searchAt = -1;
		this.outline = null;
		this.setStatus("Loading…");

		try {
			const bytes = await this.app.vault.readBinary(file);
			if (token !== this.loadToken) return;
			this.bytes = bytes;

			const { annots } = await readAnnotations(bytes.slice(0));
			if (token !== this.loadToken) return;
			this.annots = annots;

			const pdfjs = await getPdfjs();
			// pdf.js may transfer the buffer to its worker, so hand it a copy.
			this.pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
			if (token !== this.loadToken) return;

			await this.buildPages();
			if (token !== this.loadToken) return;
			this.redrawAll();
			this.updateToolbar();
			this.updateStatus();
		} catch (err) {
			console.error("Pink: failed to open", err);
			this.setStatus(`Could not open this PDF: ${(err as Error).message}`);
			new Notice("Pink: could not open this PDF. See the console for details.");
		}
	}

	async onUnloadFile(file: TFile): Promise<void> {
		window.clearTimeout(this.saveTimer);
		if (this.dirty) await this.save(true);
		this.teardownPages();
		this.bytes = null;
		this.annots = [];
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.saveTimer);
		this.cancelHide();
		if (this.dirty) await this.save(true);
		// The balloon hangs off <body>, so it outlives contentEl unless removed.
		this.tooltipEl.remove();
		this.teardownPages();
	}

	private teardownPages(): void {
		this.observer?.disconnect();
		this.observer = null;
		for (const layer of this.layers) layer.renderTask?.cancel?.();
		this.layers = [];
		this.pagesEl.empty();
		this.pdf?.destroy?.();
		this.pdf = null;
	}

	private async reload(): Promise<void> {
		if (this.file) await this.onLoadFile(this.file);
	}

	/* -------------------------------------------------------------- toolbar */

	private buildToolbar(): void {
		const bar = this.toolbarEl;
		bar.empty();

		const tools = bar.createDiv({ cls: "pink-group" });
		for (const t of TOOLS) {
			const btn = this.iconButton(tools, t.icon, `${t.label} (${t.key})`);
			btn.addEventListener("click", () => this.setTool(t.tool));
			this.toolButtons[t.tool] = btn;
		}

		const colors = bar.createDiv({ cls: "pink-group pink-swatches" });
		this.swatchEls = [];
		for (const hex of this.plugin.settings.palette) {
			const sw = colors.createEl("button", {
				cls: "pink-swatch",
				attr: { "aria-label": `Colour ${hex}`, style: `--pink-swatch: ${hex}` },
			});
			sw.dataset.color = hex;
			sw.addEventListener("click", () => this.pickColor(hex));
			this.swatchEls.push(sw);
		}

		const sliders = bar.createDiv({ cls: "pink-group" });
		this.slider(
			sliders,
			"Brush width",
			0.5,
			20,
			0.5,
			this.brushWidth,
			(v) => (this.brushWidth = v),
			(v) =>
				this.applyToSelection((a) => {
					if (a.kind === "ink") a.width = v;
				}),
		);
		this.slider(
			sliders,
			"Highlight opacity",
			0.1,
			1,
			0.05,
			this.highlightOpacity,
			(v) => (this.highlightOpacity = v),
			(v) =>
				this.applyToSelection((a) => {
					if (a.kind !== "ink") a.opacity = v;
				}),
		);

		const edit = bar.createDiv({ cls: "pink-group" });
		this.undoBtn = this.iconButton(edit, "undo-2", "Undo (Ctrl+Z)");
		this.undoBtn.addEventListener("click", () => this.undo());
		this.redoBtn = this.iconButton(edit, "redo-2", "Redo (Ctrl+Shift+Z)");
		this.redoBtn.addEventListener("click", () => this.redo());
		this.noteBtn = this.iconButton(edit, "message-square", "Edit note of selection (Enter)");
		this.noteBtn.addEventListener("click", () => this.editSelectedNote());
		this.deleteBtn = this.iconButton(edit, "trash-2", "Delete selection (Del)");
		this.deleteBtn.addEventListener("click", () => this.deleteSelection());

		const nav = bar.createDiv({ cls: "pink-group" });
		this.iconButton(nav, "list", "Table of contents").addEventListener("click", (evt) =>
			void this.showOutline(evt),
		);
		this.pageInput = nav.createEl("input", {
			cls: "pink-page-input",
			type: "text",
			attr: { "aria-label": "Go to page", title: "Go to page", inputmode: "numeric" },
		});
		this.pageTotal = nav.createSpan({ cls: "pink-page-total" });
		this.pageInput.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter") return;
			evt.preventDefault();
			const wanted = Number.parseInt(this.pageInput.value, 10);
			if (Number.isFinite(wanted)) this.goToPage(wanted - 1);
			this.syncPageBox();
			this.pageInput.blur();
		});
		this.pageInput.addEventListener("blur", () => this.syncPageBox());

		const zoom = bar.createDiv({ cls: "pink-group" });
		this.iconButton(zoom, "zoom-out", "Zoom out").addEventListener("click", () => this.zoomBy(1 / 1.2));
		this.zoomLabel = zoom.createSpan({ cls: "pink-zoom" });
		this.iconButton(zoom, "zoom-in", "Zoom in").addEventListener("click", () => this.zoomBy(1.2));

		const save = bar.createDiv({ cls: "pink-group" });
		this.saveBtn = this.iconButton(save, "save", "Save into the PDF (Ctrl+S)");
		this.saveBtn.addEventListener("click", () => void this.save(true));

		this.updateToolbar();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "pink-btn", attr: { "aria-label": label, title: label } });
		setIcon(btn, icon);
		return btn;
	}

	private slider(
		parent: HTMLElement,
		label: string,
		min: number,
		max: number,
		step: number,
		value: number,
		onInput: (v: number) => void,
		onCommit: (v: number) => void,
	): void {
		const wrap = parent.createDiv({ cls: "pink-slider", attr: { "aria-label": label, title: label } });
		const input = wrap.createEl("input", {
			type: "range",
			attr: { min: String(min), max: String(max), step: String(step), value: String(value) },
		});
		const out = wrap.createSpan({ cls: "pink-slider-value", text: String(value) });
		input.addEventListener("input", () => {
			const v = Number(input.value);
			out.setText(String(v));
			onInput(v);
		});
		// Commit on release so dragging the slider is a single undo step.
		input.addEventListener("change", () => onCommit(Number(input.value)));
	}

	private updateToolbar(): void {
		for (const t of TOOLS) this.toolButtons[t.tool]?.toggleClass("is-active", this.tool === t.tool);
		for (const sw of this.swatchEls) sw.toggleClass("is-active", sw.dataset.color === this.color);
		this.undoBtn.disabled = !this.history.canUndo;
		this.redoBtn.disabled = !this.history.canRedo;
		this.deleteBtn.disabled = this.selection.size === 0;
		this.noteBtn.disabled = this.selection.size !== 1;
		this.saveBtn.toggleClass("is-dirty", this.dirty);
		this.zoomLabel.setText(`${Math.round(this.scale * 100)}%`);
		this.syncPageBox();
	}

	private updateStatus(): void {
		const pages = this.layers.length;
		const notes = this.annots.filter((a) => a.contents.trim().length > 0).length;
		const state = this.saving ? "saving…" : this.dirty ? "unsaved" : "saved";
		this.setStatus(
			`Page ${Math.min(this.currentPage + 1, pages)} / ${pages}  ·  ` +
				`${this.annots.length} annotation${this.annots.length === 1 ? "" : "s"}` +
				(notes > 0 ? ` (${notes} with notes)` : "") +
				`  ·  ${state}` +
				(this.hasTextLayer ? "" : "  ·  no text layer: drag to select a region"),
		);
	}

	private setStatus(text: string): void {
		this.statusEl.setText(text);
	}

	/* ----------------------------------------------------------- page setup */

	private async buildPages(): Promise<void> {
		const count: number = this.pdf.numPages;
		for (let i = 0; i < count; i++) {
			const page = await this.pdf.getPage(i + 1);
			const viewport1: Viewport = page.getViewport({ scale: 1 });

			const container = this.pagesEl.createDiv({ cls: "pink-page" });
			container.dataset.page = String(i);
			const canvas = container.createEl("canvas", { cls: "pink-canvas" });
			const textEl = container.createDiv({ cls: "textLayer pink-textlayer" });
			const overlay = document.createElementNS(SVG_NS, "svg");
			overlay.addClass("pink-overlay");
			overlay.setAttribute("viewBox", `0 0 ${viewport1.width} ${viewport1.height}`);
			overlay.setAttribute("preserveAspectRatio", "none");
			container.appendChild(overlay);

			const hitBg = document.createElementNS(SVG_NS, "rect");
			hitBg.setAttribute("x", "0");
			hitBg.setAttribute("y", "0");
			hitBg.setAttribute("width", String(viewport1.width));
			hitBg.setAttribute("height", String(viewport1.height));
			hitBg.setAttribute("fill", "transparent");
			overlay.appendChild(hitBg);

			const annotGroup = document.createElementNS(SVG_NS, "g");
			const searchGroup = document.createElementNS(SVG_NS, "g");
			searchGroup.setAttribute("pointer-events", "none");
			const draftGroup = document.createElementNS(SVG_NS, "g");
			draftGroup.setAttribute("pointer-events", "none");
			overlay.appendChild(annotGroup);
			overlay.appendChild(searchGroup);
			overlay.appendChild(draftGroup);

			const layer: PageLayer = {
				index: i,
				container,
				canvas,
				textEl,
				overlay,
				hitBg,
				annotGroup,
				searchGroup,
				draftGroup,
				page,
				viewport1,
				rendered: false,
				renderTask: null,
				token: 0,
				textSpans: -1,
			};
			this.layers.push(layer);
			this.sizePage(layer);
			// Plain listeners, not registerDomEvent: these elements are thrown away
			// and rebuilt on every reload, and the listeners go with them. Handing
			// them to the component instead would pile up a set per reload.
			container.addEventListener("pointerdown", (evt) => this.onPointerDown(layer, evt));
			container.addEventListener("contextmenu", (evt) => this.onContextMenu(evt));
			container.addEventListener("dblclick", (evt) => this.onDoubleClick(evt));
			container.addEventListener("pointermove", (evt) => this.onHover(layer, evt));
			// Only start the timer: the pointer may be on its way to the balloon.
			container.addEventListener("pointerleave", () => this.scheduleHide());
		}

		this.applyToolCursor();

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const index = Number((entry.target as HTMLElement).dataset.page);
					const layer = this.layers[index];
					if (layer) void this.renderPage(layer);
				}
			},
			{ root: this.scrollEl, rootMargin: "500px 0px" },
		);
		for (const layer of this.layers) this.observer.observe(layer.container);
	}

	private sizePage(layer: PageLayer): void {
		layer.container.style.width = `${Math.floor(layer.viewport1.width * this.scale)}px`;
		layer.container.style.height = `${Math.floor(layer.viewport1.height * this.scale)}px`;
	}

	private async renderPage(layer: PageLayer): Promise<void> {
		if (layer.rendered) return;
		layer.rendered = true;
		const token = ++layer.token;
		const dpr = window.devicePixelRatio || 1;

		try {
			const viewport = layer.page.getViewport({ scale: this.scale * dpr });
			layer.canvas.width = Math.floor(viewport.width);
			layer.canvas.height = Math.floor(viewport.height);
			const ctx = layer.canvas.getContext("2d");
			if (!ctx) return;
			layer.renderTask = layer.page.render({
				canvasContext: ctx,
				viewport,
				annotationMode: ANNOTATIONS_OFF,
			});
			await layer.renderTask.promise;
			layer.renderTask = null;
			if (token !== layer.token) return;

			layer.textSpans = await renderTextLayer(
				await getPdfjs(),
				layer.page,
				layer.page.getViewport({ scale: this.scale }),
				layer.textEl,
			);
			if (layer.textSpans > 0 !== this.hasTextLayer) {
				this.hasTextLayer = this.layers.some((l) => l.textSpans > 0);
				this.updateStatus();
			}
			this.applyToolCursor();
		} catch (err: any) {
			if (token !== layer.token) return;
			if (err?.name !== "RenderingCancelledException") {
				console.error("Pink: page render failed", err);
			}
			layer.rendered = false;
		}
	}

	private zoomBy(factor: number): void {
		this.setScale(Math.min(4, Math.max(0.25, this.scale * factor)));
	}

	private setScale(scale: number): void {
		if (Math.abs(scale - this.scale) < 0.001) return;
		const anchor = this.currentPage;
		this.scale = scale;
		for (const layer of this.layers) {
			layer.renderTask?.cancel?.();
			layer.renderTask = null;
			layer.token++;
			layer.rendered = false;
			this.sizePage(layer);
		}
		this.redrawAll();
		this.updateToolbar();
		const target = this.layers[anchor];
		if (target) this.scrollEl.scrollTop = target.container.offsetTop - this.pagesEl.offsetTop;
		for (const layer of this.layers) {
			const box = layer.container.getBoundingClientRect();
			const view = this.scrollEl.getBoundingClientRect();
			if (box.bottom > view.top - 500 && box.top < view.bottom + 500) void this.renderPage(layer);
		}
	}

	/* ----------------------------------------------------------- navigation */

	/** Scrolls a page to the top of the view. Out-of-range numbers are clamped,
	 * so typing 999 lands on the last page rather than doing nothing. */
	goToPage(index: number): void {
		if (this.layers.length === 0) return;
		const layer = this.layers[Math.min(Math.max(0, index), this.layers.length - 1)];
		this.scrollEl.scrollTop = layer.container.offsetTop - this.pagesEl.offsetTop;
		void this.renderPage(layer);
	}

	private syncPageBox(): void {
		// Leave it alone while it is being typed into.
		if (document.activeElement !== this.pageInput) {
			this.pageInput.value = this.layers.length > 0 ? String(this.currentPage + 1) : "";
		}
		this.pageTotal.setText(this.layers.length > 0 ? `/ ${this.layers.length}` : "");
	}

	/** Reads the PDF's own table of contents and flattens it into a list. */
	private async ensureOutline(): Promise<void> {
		if (this.outline || !this.pdf) return;
		const flat: OutlineEntry[] = [];
		try {
			const walk = async (nodes: any[], depth: number): Promise<void> => {
				for (const node of nodes ?? []) {
					flat.push({
						title: String(node.title ?? "").trim() || "(untitled)",
						depth,
						page: await this.destinationPage(node.dest),
					});
					if (node.items?.length) await walk(node.items, depth + 1);
				}
			};
			await walk(await this.pdf.getOutline(), 0);
		} catch (err) {
			console.warn("Pink: could not read the table of contents", err);
		}
		this.outline = flat;
	}

	/** A destination is either a named one that has to be looked up, or an
	 * explicit array whose first entry is a reference to the page. */
	private async destinationPage(dest: unknown): Promise<number> {
		try {
			const explicit = typeof dest === "string" ? await this.pdf.getDestination(dest) : dest;
			if (!Array.isArray(explicit) || explicit.length === 0) return -1;
			return await this.pdf.getPageIndex(explicit[0]);
		} catch {
			return -1;
		}
	}

	private async showOutline(evt: MouseEvent): Promise<void> {
		await this.ensureOutline();
		const menu = new Menu();
		if (!this.outline || this.outline.length === 0) {
			menu.addItem((item) => item.setTitle("This PDF has no table of contents").setDisabled(true));
		} else {
			for (const entry of this.outline) {
				menu.addItem((item) =>
					item
						// Menu titles are plain text, so nesting is shown with padding.
						.setTitle("\u00a0\u00a0\u00a0\u00a0".repeat(entry.depth) + entry.title)
						.setDisabled(entry.page < 0)
						.onClick(() => this.goToPage(entry.page)),
				);
			}
		}
		menu.showAtMouseEvent(evt);
	}

	private updateCurrentPage(): void {
		const top = this.scrollEl.scrollTop;
		let index = 0;
		for (const layer of this.layers) {
			if (layer.container.offsetTop - this.pagesEl.offsetTop <= top + 60) index = layer.index;
			else break;
		}
		if (index !== this.currentPage) {
			this.currentPage = index;
			this.syncPageBox();
			this.updateStatus();
		}
	}

	/* ------------------------------------------------------------- drawing */

	private redrawAll(): void {
		for (const layer of this.layers) this.redrawPage(layer);
	}

	private redrawPage(layer: PageLayer): void {
		layer.annotGroup.empty();
		const interactive = this.tool === "select";
		layer.annotGroup.setAttribute("pointer-events", interactive ? "auto" : "none");
		for (const annot of this.annots) {
			if (annot.page !== layer.index) continue;
			this.drawAnnot(layer, annot, interactive);
		}
	}

	private drawAnnot(layer: PageLayer, annot: Annot, interactive: boolean): void {
		const vp = layer.viewport1;
		const selected = this.selection.has(annot.id);
		const group = el(layer.annotGroup, "g", { "data-annot-id": annot.id });
		group.addClass("pink-annot");
		if (selected) group.addClass("is-selected");
		const hit = interactive ? "all" : "none";

		if (annot.kind === "ink") {
			const points = annot.paths.map((path) =>
				path.map((p) => toViewportPt(vp, p.x, p.y)).map((p) => `${round(p.x)},${round(p.y)}`).join(" "),
			);
			for (const pts of points) {
				el(group, "polyline", {
					points: pts,
					fill: "none",
					stroke: rgbToCss(annot.color),
					"stroke-opacity": String(annot.opacity),
					"stroke-width": String(annot.width),
					"stroke-linecap": "round",
					"stroke-linejoin": "round",
					"pointer-events": "none",
				});
				el(group, "polyline", {
					points: pts,
					fill: "none",
					stroke: "transparent",
					"stroke-width": String(Math.max(annot.width, HIT_STROKE)),
					"stroke-linecap": "round",
					"pointer-events": hit === "all" ? "stroke" : "none",
				});
			}
		} else if (annot.kind === "highlight") {
			for (const quad of annot.quads) {
				el(group, "polygon", {
					points: quadToPoints(vp, quad),
					fill: rgbToCss(annot.color),
					"fill-opacity": String(annot.opacity),
					"pointer-events": hit,
				});
			}
		} else {
			el(group, "polygon", {
				points: quadToPoints(vp, noteMarkerRect(annot.rect)),
				fill: rgbToCss(annot.color),
				"fill-opacity": String(annot.opacity),
				stroke: "var(--background-primary)",
				"stroke-width": "0.5",
				"pointer-events": hit,
			});
		}

		// Ink and highlights that carry note text get a small corner tab. A note
		// annotation already is a marker, so a tab would just be a second box.
		if (annot.kind !== "note" && annot.contents.trim()) {
			this.drawNoteTab(group, vp, annotBounds(annot), annot, hit);
		}

		if (selected) {
			const bounds = annotBounds(annot);
			el(group, "polygon", {
				points: quadToPoints(vp, pad(bounds, 2)),
				fill: "none",
				stroke: "var(--interactive-accent)",
				"stroke-width": "1",
				"stroke-dasharray": "4 3",
				"pointer-events": "none",
			});
		}
	}

	/** Small filled corner tab marking an annotation that carries a note. */
	private drawNoteTab(
		group: SVGElement,
		vp: Viewport,
		bounds: Rect,
		annot: Annot,
		hit: string,
	): void {
		const tab: Rect = {
			x1: Math.max(bounds.x1, bounds.x2 - NOTE_TAB),
			y1: Math.max(bounds.y1, bounds.y2 - NOTE_TAB),
			x2: bounds.x2,
			y2: bounds.y2,
		};
		el(group, "polygon", {
			points: quadToPoints(vp, tab),
			fill: rgbToCss(annot.color),
			"fill-opacity": "0.95",
			stroke: "var(--background-primary)",
			"stroke-width": "0.5",
			"pointer-events": hit,
		});
	}

	/* --------------------------------------------------------- note hover */

	private onHover(layer: PageLayer, evt: PointerEvent): void {
		if (this.dragging) {
			this.hideTooltip();
			return;
		}
		if (this.hoverFrame) return;
		const { clientX, clientY } = evt;
		this.hoverFrame = window.requestAnimationFrame(() => {
			this.hoverFrame = 0;
			const annot = this.noteAt(layer, this.clientToPdf(layer, clientX, clientY));
			if (annot) {
				this.cancelHide();
				this.showTooltip(annot, layer);
			} else {
				this.scheduleHide();
			}
		});
	}

	/** Topmost annotation carrying note text under `pt`, or null. */
	private noteAt(layer: PageLayer, pt: Pt): Annot | null {
		for (let i = this.annots.length - 1; i >= 0; i--) {
			const annot = this.annots[i];
			if (annot.page !== layer.index || !annot.contents.trim()) continue;
			if (annot.kind === "highlight") {
				if (annot.quads.some((q) => rectContains(q, pt, 1))) return annot;
			} else if (annot.kind === "note") {
				if (rectContains(annot.rect, pt, 1)) return annot;
			} else if (rectContains(annotBounds(annot), pt, 0)) {
				return annot;
			}
		}
		return null;
	}

	private showTooltip(annot: Annot, layer: PageLayer): void {
		// Never pull the balloon off an annotation that is being typed into.
		if (this.hoverId !== annot.id && this.editingNote()) return;
		if (this.hoverId !== annot.id) {
			this.commitTooltipEdit();
			this.hoverId = annot.id;
			this.tooltipInput.value = annot.contents;
			this.growTooltip();
			this.tooltipEl.addClass("is-visible");
		}
		this.hoverLayer = layer;
		this.positionTooltip();
	}

	/** Sits the balloon just above the annotation, flipping below it when there
	 * is no room, with the arrow still pointing at the annotation. */
	private positionTooltip(): void {
		const layer = this.hoverLayer;
		const annot = this.hoverId ? this.annots.find((a) => a.id === this.hoverId) : null;
		if (!layer || !annot) return;

		const gap = 8;
		const bounds = annotBounds(annot);
		const midX = (bounds.x1 + bounds.x2) / 2;
		const top = this.pdfToClient(layer, { x: midX, y: bounds.y2 });
		const bottom = this.pdfToClient(layer, { x: midX, y: bounds.y1 });
		const box = this.tooltipEl.getBoundingClientRect();

		// Anchor scrolled out of the page area: let the balloon go. hideTooltip
		// refuses while it is being typed into, which is what we want.
		const view = this.scrollEl.getBoundingClientRect();
		if (bottom.y < view.top || top.y > view.bottom) {
			this.hideTooltip();
			return;
		}

		const below = top.y - box.height - gap < gap;
		const y = below ? bottom.y + gap : top.y - box.height - gap;
		const x = Math.min(Math.max(gap, top.x - box.width / 2), window.innerWidth - box.width - gap);

		const wanted = { x, y: Math.max(gap, y) };
		this.tooltipEl.toggleClass("is-below", below);
		this.tooltipEl.style.left = `${wanted.x}px`;
		this.tooltipEl.style.top = `${wanted.y}px`;

		// A fixed element resolves against the nearest transformed ancestor, not
		// always the window. Measure where it actually landed and take the offset
		// back out, so the balloon sits on the annotation under any ancestor.
		const landed = this.tooltipEl.getBoundingClientRect();
		const offX = landed.left - wanted.x;
		const offY = landed.top - wanted.y;
		if (Math.abs(offX) > 0.5 || Math.abs(offY) > 0.5) {
			this.tooltipEl.style.left = `${wanted.x - offX}px`;
			this.tooltipEl.style.top = `${wanted.y - offY}px`;
		}

		this.tooltipEl.style.setProperty("--pink-arrow", `${Math.round(top.x - wanted.x)}px`);
	}

	/** True while the caret is inside the balloon. */
	private editingNote(): boolean {
		return document.activeElement === this.tooltipInput;
	}

	/** Grows with the text, until the reader drags the corner and takes over. */
	private growTooltip(): void {
		const value = this.tooltipInput.value;
		const wrapped = Math.ceil(value.length / 42);
		this.tooltipInput.rows = Math.min(10, Math.max(2, value.split("\n").length, wrapped));
	}

	/** Writes an edited note back, as one undoable step. */
	private commitTooltipEdit(): void {
		const id = this.hoverId;
		if (!id) return;
		const text = this.tooltipInput.value;
		if (this.annots.find((a) => a.id === id)?.contents === text) return;
		this.mutate(() => {
			const target = this.annots.find((a) => a.id === id);
			if (target) target.contents = text;
		});
	}

	private scheduleHide(): void {
		window.clearTimeout(this.hoverHide);
		this.hoverHide = window.setTimeout(() => this.hideTooltip(), 240);
	}

	private cancelHide(): void {
		window.clearTimeout(this.hoverHide);
		this.hoverHide = 0;
	}

	private hideTooltip(): void {
		this.cancelHide();
		if (!this.hoverId || this.editingNote()) return;
		this.commitTooltipEdit();
		this.hoverId = null;
		this.hoverLayer = null;
		this.tooltipEl.removeClass("is-visible");
	}

	/* --------------------------------------------------------------- search */

	private buildSearchBar(): void {
		this.searchEl = this.contentEl.createDiv({ cls: "pink-search" });
		this.searchEl.hidden = true;

		this.searchInput = this.searchEl.createEl("input", {
			cls: "pink-search-input",
			type: "text",
			attr: { placeholder: "Find in document", spellcheck: "false" },
		});
		this.searchCount = this.searchEl.createSpan({ cls: "pink-search-count" });

		const prev = this.iconButton(this.searchEl, "chevron-up", "Previous match (Shift+Enter)");
		prev.addEventListener("click", () => this.stepMatch(-1));
		const next = this.iconButton(this.searchEl, "chevron-down", "Next match (Enter)");
		next.addEventListener("click", () => this.stepMatch(1));
		const close = this.iconButton(this.searchEl, "x", "Close (Esc)");
		close.addEventListener("click", () => this.closeSearch());

		let debounce = 0;
		this.registerDomEvent(this.searchInput, "input", () => {
			window.clearTimeout(debounce);
			debounce = window.setTimeout(() => void this.runSearch(), 180);
		});
		this.registerDomEvent(this.searchInput, "keydown", (evt) => {
			if (evt.key === "Escape") {
				evt.preventDefault();
				this.closeSearch();
			} else if (evt.key === "Enter") {
				evt.preventDefault();
				// Enter before the debounce has fired should search, not step.
				if (this.searchMatches.length === 0) void this.runSearch();
				else this.stepMatch(evt.shiftKey ? -1 : 1);
			}
		});
	}

	openSearch(): void {
		this.searchEl.hidden = false;
		this.searchInput.focus();
		this.searchInput.select();
	}

	private closeSearch(): void {
		this.searchEl.hidden = true;
		this.searchMatches = [];
		this.searchAt = -1;
		this.drawSearchHits();
		this.contentEl.focus();
	}

	/** Reads the text of every page once, and keeps where each run sits so a
	 * match can be turned back into a rectangle on the page. */
	private async ensureSearchIndex(): Promise<void> {
		if (this.searchPages.length === this.layers.length) return;
		const pages: (PageText | null)[] = [];
		for (const layer of this.layers) {
			try {
				const content = await layer.page.getTextContent();
				let text = "";
				const boxes: TextBox[] = [];
				for (const item of content.items as any[]) {
					const str: string = item.str ?? "";
					if (str.length > 0) {
						const t: number[] = item.transform;
						boxes.push({
							start: text.length,
							len: str.length,
							x: t[4],
							y: t[5],
							w: item.width ?? 0,
							h: item.height ?? 0,
						});
						text += str;
					}
					// pdf.js emits no space at a line break, which would glue the last
					// word of a line to the first of the next one.
					if (item.hasEOL) text += " ";
				}
				pages.push({ text: text.toLowerCase(), boxes });
			} catch (err) {
				console.warn("Pink: could not read text of page", layer.index + 1, err);
				pages.push(null);
			}
		}
		this.searchPages = pages;
	}

	private async runSearch(): Promise<void> {
		const needle = this.searchInput.value.trim().toLowerCase();
		this.searchMatches = [];
		this.searchAt = -1;

		if (needle.length > 0) {
			await this.ensureSearchIndex();
			this.searchPages.forEach((page, index) => {
				if (!page) return;
				let at = page.text.indexOf(needle);
				while (at !== -1) {
					const rects = this.matchRects(page, at, at + needle.length);
					if (rects.length > 0) this.searchMatches.push({ page: index, rects });
					at = page.text.indexOf(needle, at + needle.length);
				}
			});
			if (this.searchMatches.length > 0) this.searchAt = 0;
		}

		this.drawSearchHits();
		this.updateSearchCount();
		if (this.searchAt >= 0) this.revealMatch();
	}

	/** Turns a span of the page text back into rectangles. Inside one run the
	 * position is worked out by character count, which is an approximation for
	 * proportional fonts but plenty for showing where a hit is. */
	private matchRects(page: PageText, from: number, to: number): Rect[] {
		const rects: Rect[] = [];
		for (const box of page.boxes) {
			const start = Math.max(from, box.start);
			const end = Math.min(to, box.start + box.len);
			if (start >= end || box.len === 0) continue;
			rects.push({
				x1: box.x + (box.w * (start - box.start)) / box.len,
				y1: box.y,
				x2: box.x + (box.w * (end - box.start)) / box.len,
				y2: box.y + box.h,
			});
		}
		return rects;
	}

	private stepMatch(by: number): void {
		if (this.searchMatches.length === 0) return;
		const count = this.searchMatches.length;
		this.searchAt = (this.searchAt + by + count) % count;
		this.drawSearchHits();
		this.updateSearchCount();
		this.revealMatch();
	}

	private drawSearchHits(): void {
		for (const layer of this.layers) layer.searchGroup.empty();
		this.searchMatches.forEach((match, index) => {
			const layer = this.layers[match.page];
			if (!layer) return;
			for (const rect of match.rects) {
				const hit = el(layer.searchGroup, "polygon", {
					points: quadToPoints(layer.viewport1, rect),
					"pointer-events": "none",
				});
				hit.addClass("pink-search-hit");
				if (index === this.searchAt) hit.addClass("is-current");
			}
		});
	}

	private updateSearchCount(): void {
		const total = this.searchMatches.length;
		const query = this.searchInput.value.trim();
		if (query.length === 0) this.searchCount.setText("");
		else if (total === 0) this.searchCount.setText("no matches");
		else this.searchCount.setText(`${this.searchAt + 1} / ${total}`);
	}

	private revealMatch(): void {
		const match = this.searchMatches[this.searchAt];
		const layer = match ? this.layers[match.page] : null;
		if (!match || !layer) return;
		void this.renderPage(layer);
		const bounds = unionRects(match.rects);
		const spot = toViewportPt(layer.viewport1, bounds.x1, bounds.y2);
		const top = layer.container.offsetTop - this.pagesEl.offsetTop + spot.y * this.scale;
		this.scrollEl.scrollTop = Math.max(0, top - this.scrollEl.clientHeight / 3);
	}

	/* --------------------------------------------------------- interaction */

	private setTool(tool: ToolName): void {
		// Leaving the text tool with words still lit would look like a live
		// selection that no longer does anything.
		if (this.tool === "text" && tool !== "text") window.getSelection()?.removeAllRanges();
		this.tool = tool;
		this.hideTooltip();
		if (tool !== "select") this.selection.clear();
		this.applyToolCursor();
		this.redrawAll();
		this.updateToolbar();
	}

	private applyToolCursor(): void {
		const selectable = this.tool === "text" || this.tool === "highlight" || this.tool === "note";
		const drawing = this.tool === "select" || this.tool === "brush";
		this.contentEl.dataset.tool = this.tool;
		for (const layer of this.layers) {
			layer.textEl.style.pointerEvents = selectable ? "auto" : "none";
			layer.hitBg.setAttribute("pointer-events", drawing ? "all" : "none");
		}
	}

	private pickColor(hex: string): void {
		this.color = hex;
		const rgb = hexToRgb(hex);
		this.applyToSelection((a) => {
			a.color = { ...rgb };
		});
		this.updateToolbar();
	}

	private clientToPdf(layer: PageLayer, clientX: number, clientY: number): Pt {
		const box = layer.overlay.getBoundingClientRect();
		const sx = ((clientX - box.left) * layer.viewport1.width) / (box.width || 1);
		const sy = ((clientY - box.top) * layer.viewport1.height) / (box.height || 1);
		return toPdfPt(layer.viewport1, sx, sy);
	}

	private pdfToClient(layer: PageLayer, pt: Pt): { x: number; y: number } {
		const box = layer.overlay.getBoundingClientRect();
		const v = toViewportPt(layer.viewport1, pt.x, pt.y);
		return {
			x: box.left + (v.x * box.width) / (layer.viewport1.width || 1),
			y: box.top + (v.y * box.height) / (layer.viewport1.height || 1),
		};
	}

	private onPointerDown(layer: PageLayer, evt: PointerEvent): void {
		if (evt.button !== 0) return;
		const start = this.clientToPdf(layer, evt.clientX, evt.clientY);

		// The text tool does nothing of its own: it just leaves the text layer
		// exposed so the browser can select, and the selection survives for Ctrl+C
		// because nothing here consumes it.
		if (this.tool === "text") return;

		if (this.tool === "brush") {
			evt.preventDefault();
			this.beginBrush(layer, start);
			return;
		}

		if (this.tool === "select") {
			const id = annotIdAt(evt.target);
			if (id) {
				this.toggleSelect(id, evt.shiftKey);
				return;
			}
			evt.preventDefault();
			this.beginMarquee(layer, start, evt, (rect, additive) => this.selectWithin(layer, rect, additive));
			return;
		}

		// Highlight and note both work off the browser's text selection.
		this.beginRegion(layer, start, evt);
	}

	private beginBrush(layer: PageLayer, start: Pt): void {
		const points: Pt[] = [start];
		const preview = el(layer.draftGroup, "polyline", {
			fill: "none",
			stroke: rgbToCss(hexToRgb(this.color)),
			"stroke-opacity": String(this.plugin.settings.brushOpacity),
			"stroke-width": String(this.brushWidth),
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
		});
		const paint = () => {
			preview.setAttribute(
				"points",
				points.map((p) => toViewportPt(layer.viewport1, p.x, p.y)).map((p) => `${round(p.x)},${round(p.y)}`).join(" "),
			);
		};
		paint();

		this.trackDrag(
			(move) => {
				const p = this.clientToPdf(layer, move.clientX, move.clientY);
				const last = points[points.length - 1];
				if (Math.hypot(p.x - last.x, p.y - last.y) < BRUSH_MIN_STEP) return;
				points.push(p);
				paint();
			},
			() => {
				preview.remove();
				this.mutate(() => {
					this.annots.push({
						id: newAnnotId(),
						kind: "ink",
						page: layer.index,
						color: hexToRgb(this.color),
						opacity: this.plugin.settings.brushOpacity,
						contents: "",
						author: DEFAULT_AUTHOR,
						width: this.brushWidth,
						paths: [points],
					});
				});
			},
		);
	}

	private beginMarquee(
		layer: PageLayer,
		start: Pt,
		evt: PointerEvent,
		onDone: (rect: Rect, additive: boolean) => void,
	): void {
		const origin = { x: evt.clientX, y: evt.clientY };
		const preview = el(layer.draftGroup, "polygon", { class: "pink-marquee", points: "" });
		let current = start;
		this.trackDrag(
			(move) => {
				current = this.clientToPdf(layer, move.clientX, move.clientY);
				preview.setAttribute("points", quadToPoints(layer.viewport1, normRect(start, current)));
			},
			(up) => {
				preview.remove();
				if (Math.hypot(up.clientX - origin.x, up.clientY - origin.y) < CLICK_SLOP) {
					if (!evt.shiftKey) this.clearSelection();
					return;
				}
				onDone(normRect(start, current), evt.shiftKey);
			},
		);
	}

	private beginRegion(layer: PageLayer, start: Pt, evt: PointerEvent): void {
		// Both tools follow the words you select with the mouse, the way a browser
		// PDF viewer works: once the pointer moves, the result is whatever text
		// was selected, never a free rectangle. The single exception is a note
		// placed with a plain click, which drops its marker wherever you clicked
		// so figures can be annotated too.
		const origin = { x: evt.clientX, y: evt.clientY };
		let dragged = false;

		// Releasing the mouse past the end of the last line makes the browser drop
		// the selection entirely, so remember the last good one as the drag runs.
		let lastQuads: Rect[] | null = null;
		const remember = () => {
			const quads = this.quadsFromTextSelection(layer);
			if (quads) lastQuads = quads;
		};
		document.addEventListener("selectionchange", remember);

		this.trackDrag(
			(move) => {
				// Sticky: a drag that wanders out and back is still a drag.
				dragged ||= Math.hypot(move.clientX - origin.x, move.clientY - origin.y) >= CLICK_SLOP;
			},
			() => {
				document.removeEventListener("selectionchange", remember);
				// Only a drag reads the text selection. Without this a click landing
				// inside a selection left over from before would paint those words
				// instead of dropping a marker where the pointer actually is.
				let quads = dragged ? this.quadsFromTextSelection(layer) ?? lastQuads : null;
				const onText = quads !== null;
				if (!quads && !dragged && this.tool === "note") {
					quads = [{ x1: start.x, y1: start.y - NOTE_MARKER, x2: start.x + NOTE_MARKER, y2: start.y }];
				}
				window.getSelection()?.removeAllRanges();
				if (!quads || quads.length === 0) {
					if (dragged) this.hintTextSelection(layer);
					return;
				}
				if (this.tool === "highlight") this.commitHighlight(layer, quads);
				else this.commitNote(layer, quads, onText);
			},
		);
	}

	/** Explains, once per document, why a drag produced nothing. */
	private hintTextSelection(layer: PageLayer): void {
		const selection = window.getSelection();
		console.warn(`Pink: ${this.tool} found no text`, {
			page: layer.index + 1,
			textSpans: layer.textSpans,
			selectionEmpty: !selection || selection.isCollapsed,
			selectionText: selection?.toString().slice(0, 80) ?? "",
		});
		if (this.hintShown) return;
		this.hintShown = true;
		if (layer.textSpans === 0) {
			new Notice("This page has no selectable text. Click once with the note tool to place a note anywhere on it.", 8000);
		} else if (layer.textSpans < 0) {
			new Notice("The text layer for this PDF could not be built, so selecting text is unavailable. See the console for details.", 8000);
		} else {
			new Notice("Highlights and notes follow the text you select. Drag across the words you want, or click once with the note tool to place a free note.", 6000);
		}
	}

	private commitHighlight(layer: PageLayer, quads: Rect[]): void {
		this.mutate(() => {
			this.annots.push({
				id: newAnnotId(),
				kind: "highlight",
				page: layer.index,
				color: hexToRgb(this.color),
				opacity: this.highlightOpacity,
				contents: "",
				author: DEFAULT_AUTHOR,
				quads,
			});
		});
	}

	/** A note taken over selected words paints them the way the highlight tool
	 * does and carries the text as its contents, so the passage it belongs to
	 * stays visible on the page. A note placed with a plain click has no words
	 * to paint, so it stays a small square marker. */
	private commitNote(layer: PageLayer, quads: Rect[], onText: boolean): void {
		new NoteModal(this.app, "Add note", "", false, (result) => {
			if (!result || result.action !== "save" || result.text.trim() === "") return;
			this.mutate(() => {
				const base = {
					id: newAnnotId(),
					page: layer.index,
					color: hexToRgb(this.color),
					contents: result.text,
					author: DEFAULT_AUTHOR,
				};
				this.annots.push(
					onText
						? { ...base, kind: "highlight", opacity: this.highlightOpacity, quads }
						: { ...base, kind: "note", opacity: 1, rect: unionRects(quads) },
				);
			});
		}).open();
	}

	/** Converts the current DOM text selection into PDF-space quads. */
	private quadsFromTextSelection(layer: PageLayer): Rect[] | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		if (!layer.textEl.contains(range.commonAncestorContainer)) return null;

		const quads: Rect[] = [];
		for (const box of Array.from(range.getClientRects())) {
			if (box.width < 0.5 || box.height < 0.5) continue;
			const a = this.clientToPdf(layer, box.left, box.top);
			const b = this.clientToPdf(layer, box.right, box.bottom);
			quads.push(normRect(a, b));
		}
		return quads.length > 0 ? mergeLineQuads(dropContainers(quads)) : null;
	}

	/** Runs pointer move/up on the document so a drag survives leaving the page. */
	private trackDrag(onMove: (evt: PointerEvent) => void, onEnd: (evt: PointerEvent) => void): void {
		this.dragging = true;
		this.hideTooltip();
		const move = (evt: PointerEvent) => onMove(evt);
		const up = (evt: PointerEvent) => {
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerup", up);
			document.removeEventListener("pointercancel", up);
			this.dragging = false;
			onEnd(evt);
		};
		document.addEventListener("pointermove", move);
		document.addEventListener("pointerup", up);
		document.addEventListener("pointercancel", up);
	}

	private onDoubleClick(evt: MouseEvent): void {
		const id = annotIdAt(evt.target);
		if (!id) return;
		evt.preventDefault();
		this.selection.clear();
		this.selection.add(id);
		this.redrawAll();
		this.editSelectedNote();
	}

	private onContextMenu(evt: MouseEvent): void {
		const id = annotIdAt(evt.target);
		if (!id) return;
		evt.preventDefault();
		if (!this.selection.has(id)) {
			this.selection.clear();
			this.selection.add(id);
			this.redrawAll();
			this.updateToolbar();
		}
		const annot = this.annots.find((a) => a.id === id);
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(annot && annot.contents ? "Edit note" : "Add note")
				.setIcon("message-square")
				.onClick(() => this.editSelectedNote()),
		);
		if (annot && annot.contents) {
			menu.addItem((item) =>
				item
					.setTitle("Remove note text")
					.setIcon("eraser")
					.onClick(() =>
						this.mutate(() => {
							const target = this.annots.find((a) => a.id === id);
							if (target) target.contents = "";
						}),
					),
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(`Delete ${this.selection.size > 1 ? `${this.selection.size} annotations` : "annotation"}`)
				.setIcon("trash-2")
				.onClick(() => this.deleteSelection()),
		);
		menu.showAtMouseEvent(evt);
	}

	/* ---------------------------------------------------------- selection */

	private toggleSelect(id: string, additive: boolean): void {
		if (!additive) {
			const only = this.selection.size === 1 && this.selection.has(id);
			this.selection.clear();
			if (!only) this.selection.add(id);
		} else if (this.selection.has(id)) {
			this.selection.delete(id);
		} else {
			this.selection.add(id);
		}
		this.redrawAll();
		this.updateToolbar();
	}

	private selectWithin(layer: PageLayer, rect: Rect, additive: boolean): void {
		if (!additive) this.selection.clear();
		for (const annot of this.annots) {
			if (annot.page !== layer.index) continue;
			if (intersects(rect, annotBounds(annot))) this.selection.add(annot.id);
		}
		this.redrawAll();
		this.updateToolbar();
	}

	private clearSelection(): void {
		if (this.selection.size === 0) return;
		this.selection.clear();
		this.redrawAll();
		this.updateToolbar();
	}

	selectAllOnPage(): void {
		this.setTool("select");
		for (const annot of this.annots) {
			if (annot.page === this.currentPage) this.selection.add(annot.id);
		}
		this.redrawAll();
		this.updateToolbar();
	}

	deleteSelection(): void {
		if (this.selection.size === 0) return;
		const doomed = new Set(this.selection);
		this.mutate(() => {
			this.annots = this.annots.filter((a) => !doomed.has(a.id));
			this.selection.clear();
		});
	}

	private applyToSelection(fn: (annot: Annot) => void): void {
		if (this.selection.size === 0) return;
		this.mutate(() => {
			for (const annot of this.annots) if (this.selection.has(annot.id)) fn(annot);
		});
	}

	editSelectedNote(): void {
		if (this.selection.size !== 1) return;
		const id = [...this.selection][0];
		const annot = this.annots.find((a) => a.id === id);
		if (!annot) return;
		new NoteModal(this.app, annot.contents ? "Edit note" : "Add note", annot.contents, true, (result) => {
			if (!result) return;
			if (result.action === "delete") {
				this.deleteSelection();
				return;
			}
			this.mutate(() => {
				const target = this.annots.find((a) => a.id === id);
				if (target) target.contents = result.text;
			});
		}).open();
	}

	/* -------------------------------------------------------- undo / redo */

	/** Records an undo snapshot, applies `fn`, then repaints and schedules a save. */
	private mutate(fn: () => void): void {
		this.history.push(cloneAnnots(this.annots));
		fn();
		this.afterChange();
	}

	private afterChange(): void {
		this.dirty = true;
		this.redrawAll();
		this.updateToolbar();
		this.updateStatus();
		this.scheduleSave();
	}

	undo(): void {
		const previous = this.history.undo(cloneAnnots(this.annots));
		if (!previous) return;
		this.annots = previous;
		this.pruneSelection();
		this.afterChange();
	}

	redo(): void {
		const next = this.history.redo(cloneAnnots(this.annots));
		if (!next) return;
		this.annots = next;
		this.pruneSelection();
		this.afterChange();
	}

	private pruneSelection(): void {
		const alive = new Set(this.annots.map((a) => a.id));
		for (const id of [...this.selection]) if (!alive.has(id)) this.selection.delete(id);
	}

	/* -------------------------------------------------------------- saving */

	private scheduleSave(): void {
		window.clearTimeout(this.saveTimer);
		if (!this.plugin.settings.autosave) return;
		this.saveTimer = window.setTimeout(() => void this.save(), this.plugin.settings.autosaveDelayMs);
	}

	async save(force = false): Promise<void> {
		if (!this.file || !this.bytes) return;
		if (!this.dirty && !force) return;
		if (this.saving) return;
		this.saving = true;
		this.updateStatus();
		try {
			const out = await writeAnnotations(this.bytes.slice(0), this.annots);
			this.selfWrite = true;
			await this.app.vault.modifyBinary(this.file, toArrayBuffer(out));
			this.dirty = false;
		} catch (err) {
			console.error("Pink: save failed", err);
			new Notice(`Pink: could not save — ${(err as Error).message}`);
		} finally {
			this.saving = false;
			window.setTimeout(() => (this.selfWrite = false), 1500);
			this.updateToolbar();
			this.updateStatus();
		}
	}

	/* ------------------------------------------------------------ keyboard */

	private onKeyDown(evt: KeyboardEvent): void {
		const mod = evt.ctrlKey || evt.metaKey;

		if (mod && evt.key.toLowerCase() === "z") {
			evt.preventDefault();
			evt.stopPropagation();
			if (evt.shiftKey) this.redo();
			else this.undo();
			return;
		}
		if (mod && evt.key.toLowerCase() === "y") {
			evt.preventDefault();
			this.redo();
			return;
		}
		if (mod && evt.key.toLowerCase() === "s") {
			evt.preventDefault();
			void this.save(true);
			return;
		}
		if (mod && evt.key.toLowerCase() === "f") {
			evt.preventDefault();
			evt.stopPropagation();
			this.openSearch();
			return;
		}
		if (mod && evt.key.toLowerCase() === "a") {
			evt.preventDefault();
			this.selectAllOnPage();
			return;
		}
		if (evt.key === "Delete" || evt.key === "Backspace") {
			if (this.selection.size === 0) return;
			evt.preventDefault();
			this.deleteSelection();
			return;
		}
		if (evt.key === "Escape") {
			this.clearSelection();
			return;
		}
		if (evt.key === "Enter") {
			if (this.selection.size === 1) {
				evt.preventDefault();
				this.editSelectedNote();
			}
			return;
		}
		if (mod) return;

		// Plain +/-/0, the way every PDF reader does it. Ctrl+= and Ctrl+- are
		// left alone because Electron uses them to zoom the whole app.
		if (evt.key === "+" || evt.key === "=") {
			evt.preventDefault();
			this.zoomBy(1.2);
			return;
		}
		if (evt.key === "-" || evt.key === "_") {
			evt.preventDefault();
			this.zoomBy(1 / 1.2);
			return;
		}
		if (evt.key === "0") {
			evt.preventDefault();
			this.setScale(this.plugin.settings.defaultZoom);
			return;
		}

		const byKey = TOOLS.find((t) => t.key.toLowerCase() === evt.key.toLowerCase());
		if (byKey) {
			evt.preventDefault();
			this.setTool(byKey.tool);
		}
	}

	/* --------------------------------------------------- command surface */

	setToolExternal(tool: ToolName): void {
		this.setTool(tool);
	}
}

/* --------------------------------------------------------------- helpers */

function el<K extends keyof SVGElementTagNameMap>(
	parent: Element,
	tag: K,
	attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	parent.appendChild(node);
	return node;
}

function quadToPoints(vp: Viewport, quad: Rect): string {
	return [
		{ x: quad.x1, y: quad.y2 },
		{ x: quad.x2, y: quad.y2 },
		{ x: quad.x2, y: quad.y1 },
		{ x: quad.x1, y: quad.y1 },
	]
		.map((p) => toViewportPt(vp, p.x, p.y))
		.map((p) => `${round(p.x)},${round(p.y)}`)
		.join(" ");
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function pad(rect: Rect, amount: number): Rect {
	return { x1: rect.x1 - amount, y1: rect.y1 - amount, x2: rect.x2 + amount, y2: rect.y2 + amount };
}

function intersects(a: Rect, b: Rect): boolean {
	return !(b.x1 > a.x2 || b.x2 < a.x1 || b.y1 > a.y2 || b.y2 < a.y1);
}

function annotIdAt(target: EventTarget | null): string | null {
	let node = target as Element | null;
	while (node) {
		const id = node.getAttribute?.("data-annot-id");
		if (id) return id;
		node = node.parentElement;
	}
	return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

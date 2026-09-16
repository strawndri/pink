import { Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, PinkSettingTab, PinkSettings, ToolName } from "./settings";
import { PinkView, VIEW_TYPE_PINK } from "./view";

export default class PinkPlugin extends Plugin {
	settings: PinkSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_PINK, (leaf) => new PinkView(leaf, this));

		if (this.settings.takeOverPdfView) {
			try {
				this.registerExtensions(["pdf"], VIEW_TYPE_PINK);
			} catch (err) {
				console.error("Pink: could not claim the .pdf extension", err);
			}
		}

		this.addSettingTab(new PinkSettingTab(this.app, this));
		this.addCommands();

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "pdf") return;
				menu.addItem((item) =>
					item
						.setTitle("Annotate PDF")
						.setIcon("highlighter")
						.onClick(() => void this.openInAnnotator(file)),
				);
			}),
		);
	}

	private addCommands(): void {
		this.addCommand({
			id: "open-in-annotator",
			name: "Open current PDF in Pink",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "pdf") return false;
				if (!checking) void this.openInAnnotator(file);
				return true;
			},
		});

		const tools: { tool: ToolName; name: string }[] = [
			{ tool: "select", name: "Select tool" },
			{ tool: "text", name: "Text selection tool" },
			{ tool: "brush", name: "Brush tool" },
			{ tool: "highlight", name: "Highlight tool" },
			{ tool: "note", name: "Note tool" },
		];
		for (const { tool, name } of tools) {
			this.addViewCommand(`tool-${tool}`, name, (view) => view.setToolExternal(tool));
		}

		this.addViewCommand("undo", "Undo annotation", (view) => view.undo());
		this.addViewCommand("redo", "Redo annotation", (view) => view.redo());
		this.addViewCommand("delete-selection", "Delete selected annotations", (view) => view.deleteSelection());
		this.addViewCommand("edit-note", "Edit note of selected annotation", (view) => view.editSelectedNote());
		this.addViewCommand("select-all", "Select all annotations on this page", (view) => view.selectAllOnPage());
		this.addViewCommand("save", "Save annotations into the PDF", (view) => void view.save(true));
		this.addViewCommand("find", "Find in document", (view) => view.openSearch());
		this.addViewCommand("toggle-dark", "Toggle dark PDF", (view) => view.toggleDark());
	}

	private addViewCommand(id: string, name: string, run: (view: PinkView) => void): void {
		this.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(PinkView);
				if (!view) return false;
				if (!checking) run(view);
				return true;
			},
		});
	}

	private async openInAnnotator(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE_PINK, state: { file: file.path } });
		this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

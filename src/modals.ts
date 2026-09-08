import { App, Modal, Setting } from "obsidian";

export interface NoteResult {
	action: "save" | "delete";
	text: string;
}

/** Small editor for the text attached to a highlight or a region note. */
export class NoteModal extends Modal {
	private text: string;
	private resolved = false;

	constructor(
		app: App,
		private readonly title: string,
		initial: string,
		private readonly allowDelete: boolean,
		private readonly onDone: (result: NoteResult | null) => void,
	) {
		super(app);
		this.text = initial;
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.addClass("pink-note-modal");

		const area = this.contentEl.createEl("textarea", {
			cls: "pink-note-textarea",
			attr: { rows: "6", placeholder: "Write your note…" },
		});
		area.value = this.text;
		area.addEventListener("input", () => (this.text = area.value));
		area.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
				evt.preventDefault();
				this.finish({ action: "save", text: this.text });
			}
		});
		window.setTimeout(() => area.focus(), 0);

		const buttons = new Setting(this.contentEl);
		if (this.allowDelete) {
			buttons.addButton((b) =>
				b
					.setButtonText("Delete annotation")
					.setWarning()
					.onClick(() => this.finish({ action: "delete", text: "" })),
			);
		}
		buttons.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		buttons.addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(() => this.finish({ action: "save", text: this.text })),
		);
	}

	private finish(result: NoteResult): void {
		this.resolved = true;
		this.onDone(result);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.onDone(null);
	}
}

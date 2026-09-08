import { App, PluginSettingTab, Setting } from "obsidian";
import type PinkPlugin from "./main";

export type ToolName = "select" | "text" | "brush" | "highlight" | "note";

export interface PinkSettings {
	defaultTool: ToolName;
	brushColor: string;
	brushWidth: number;
	brushOpacity: number;
	highlightColor: string;
	highlightOpacity: number;
	palette: string[];
	autosave: boolean;
	autosaveDelayMs: number;
	defaultZoom: number;
	takeOverPdfView: boolean;
}

export const DEFAULT_SETTINGS: PinkSettings = {
	defaultTool: "select",
	brushColor: "#e5484d",
	brushWidth: 2.5,
	brushOpacity: 1,
	highlightColor: "#ffd60a",
	highlightOpacity: 0.4,
	palette: ["#ffd60a", "#4ade80", "#38bdf8", "#e5484d", "#c084fc", "#fb923c", "#111111"],
	autosave: true,
	autosaveDelayMs: 1200,
	defaultZoom: 1.2,
	takeOverPdfView: true,
};

export class PinkSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: PinkPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Viewer").setHeading();

		new Setting(containerEl)
			.setName("Open PDFs with the annotator")
			.setDesc(
				"Replace Obsidian's built-in PDF viewer. When off, use the \"Open current PDF in Pink\" command instead. Requires reloading Obsidian.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.takeOverPdfView).onChange(async (v) => {
					this.plugin.settings.takeOverPdfView = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Default zoom")
			.setDesc("Zoom level used when a PDF is opened.")
			.addSlider((s) =>
				s
					.setLimits(0.5, 3, 0.1)
					.setValue(this.plugin.settings.defaultZoom)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.defaultZoom = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Default tool")
			.addDropdown((d) =>
				d
					.addOptions({ select: "Select", text: "Select text", brush: "Brush", highlight: "Highlight", note: "Note" })
					.setValue(this.plugin.settings.defaultTool)
					.onChange(async (v) => {
						this.plugin.settings.defaultTool = v as ToolName;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Brush").setHeading();

		new Setting(containerEl).setName("Colour").addColorPicker((c) =>
			c.setValue(this.plugin.settings.brushColor).onChange(async (v) => {
				this.plugin.settings.brushColor = v;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName("Width")
			.setDesc("Stroke width in PDF points.")
			.addSlider((s) =>
				s
					.setLimits(0.5, 20, 0.5)
					.setValue(this.plugin.settings.brushWidth)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.brushWidth = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Opacity").addSlider((s) =>
			s
				.setLimits(0.1, 1, 0.05)
				.setValue(this.plugin.settings.brushOpacity)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.brushOpacity = v;
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl).setName("Highlight").setHeading();

		new Setting(containerEl).setName("Colour").addColorPicker((c) =>
			c.setValue(this.plugin.settings.highlightColor).onChange(async (v) => {
				this.plugin.settings.highlightColor = v;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName("Opacity").addSlider((s) =>
			s
				.setLimits(0.1, 1, 0.05)
				.setValue(this.plugin.settings.highlightOpacity)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.highlightOpacity = v;
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl).setName("Saving").setHeading();

		new Setting(containerEl)
			.setName("Autosave")
			.setDesc("Write annotations back into the PDF shortly after each change.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autosave).onChange(async (v) => {
					this.plugin.settings.autosave = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Autosave delay")
			.setDesc("Milliseconds of inactivity before saving.")
			.addSlider((s) =>
				s
					.setLimits(300, 5000, 100)
					.setValue(this.plugin.settings.autosaveDelayMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.autosaveDelayMs = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Palette").setHeading();

		new Setting(containerEl)
			.setName("Swatch colours")
			.setDesc("Comma-separated hex colours shown in the toolbar.")
			.addTextArea((t) =>
				t
					.setValue(this.plugin.settings.palette.join(", "))
					.setPlaceholder("#ffd60a, #4ade80")
					.onChange(async (v) => {
						const colors = v
							.split(",")
							.map((c) => c.trim())
							.filter((c) => /^#?[\da-f]{6}$/i.test(c))
							.map((c) => (c.startsWith("#") ? c : `#${c}`));
						if (colors.length > 0) {
							this.plugin.settings.palette = colors;
							await this.plugin.saveSettings();
						}
					}),
			);
	}
}

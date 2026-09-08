/** Copies the built plugin into an Obsidian vault.
 *
 *   npm run deploy                 -> uses $OBSIDIAN_VAULT, then .vaultpath
 *   npm run deploy -- /path/vault  -> explicit vault root
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PLUGIN_ID = JSON.parse(await fs.readFile("manifest.json", "utf8")).id;
const FILES = ["main.js", "manifest.json", "styles.css"];

async function resolveVault() {
	const explicit = process.argv[2] || process.env.OBSIDIAN_VAULT;
	if (explicit) return explicit.replace(/^~/, os.homedir());
	try {
		const saved = (await fs.readFile(".vaultpath", "utf8")).trim();
		if (saved) return saved.replace(/^~/, os.homedir());
	} catch {
		/* no saved path */
	}
	throw new Error(
		"No vault given. Pass one (npm run deploy -- /path/to/vault), set OBSIDIAN_VAULT, " +
			"or write the path into a .vaultpath file.",
	);
}

const vault = await resolveVault();
if (!(await fs.stat(path.join(vault, ".obsidian")).catch(() => null))) {
	throw new Error(`${vault} does not look like an Obsidian vault (no .obsidian directory).`);
}

const target = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);
await fs.mkdir(target, { recursive: true });
for (const file of FILES) {
	await fs.copyFile(file, path.join(target, file));
}
console.log(`Installed ${PLUGIN_ID} -> ${target}`);
console.log("In Obsidian: reload with Ctrl+R, then enable it in Settings -> Community plugins.");

/** Bumps the plugin version everywhere it is written down.
 *
 *   node bump.mjs patch|minor|major|1.2.3 [--min-app 1.7.0] [--dry-run]
 *
 * manifest.json is the one Obsidian reads, package.json keeps npm honest, and
 * versions.json maps each plugin version to the oldest Obsidian that can run it,
 * so people on older apps keep getting the last version that works for them.
 * They have to agree: a mismatch fails silently, which is the worst kind.
 */
import fs from "node:fs/promises";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const minAppIdx = args.indexOf("--min-app");
const minApp = minAppIdx === -1 ? null : args[minAppIdx + 1];
const how = args.find((a) => !a.startsWith("--") && a !== minApp);

if (!how) {
	console.error("Usage: node bump.mjs patch|minor|major|X.Y.Z [--min-app X.Y.Z] [--dry-run]");
	process.exit(1);
}

const read = async (f) => JSON.parse(await fs.readFile(f, "utf8"));
/** Two spaces and a trailing newline, matching what is already in the repo. */
const write = async (f, data) => {
	if (dry) return;
	await fs.writeFile(f, JSON.stringify(data, null, 2) + "\n");
};

const manifest = await read("manifest.json");
const current = manifest.version;

function next(from, how) {
	if (/^\d+\.\d+\.\d+$/.test(how)) return how;
	const [maj, min, pat] = from.split(".").map(Number);
	if (how === "major") return `${maj + 1}.0.0`;
	if (how === "minor") return `${maj}.${min + 1}.0`;
	if (how === "patch") return `${maj}.${min}.${pat + 1}`;
	throw new Error(`Don't know how to bump "${how}".`);
}

const version = next(current, how);
if (version === current) {
	console.error(`Already at ${current}. Nothing to do.`);
	process.exit(1);
}

const changes = [];

manifest.version = version;
if (minApp) manifest.minAppVersion = minApp;
await write("manifest.json", manifest);
changes.push(`manifest.json  ${current} -> ${version}${minApp ? `, minAppVersion ${minApp}` : ""}`);

const pkg = await read("package.json");
pkg.version = version;
await write("package.json", pkg);
changes.push(`package.json   ${current} -> ${version}`);

// The lockfile carries the version in two places when it is lockfileVersion 2+.
try {
	const lock = await read("package-lock.json");
	lock.version = version;
	if (lock.packages?.[""]) lock.packages[""].version = version;
	await write("package-lock.json", lock);
	changes.push(`package-lock.json`);
} catch {
	/* no lockfile, fine */
}

// Only grows when the Obsidian requirement actually changed. An extra line that
// repeats the previous requirement is noise, and noise here is hard to read later.
const versions = await read("versions.json");
const previousMin = Object.values(versions).at(-1);
const requiredMin = manifest.minAppVersion;
if (requiredMin !== previousMin) {
	versions[version] = requiredMin;
	await write("versions.json", versions);
	changes.push(`versions.json  + "${version}": "${requiredMin}"`);
} else {
	changes.push(`versions.json  untouched (still needs Obsidian ${requiredMin})`);
}

console.log(dry ? `Dry run, nothing written:\n` : `Bumped to ${version}:\n`);
for (const c of changes) console.log(`  ${c}`);
console.log(`
Next:
  git add manifest.json package.json package-lock.json versions.json
  git commit -m "chore: bump version to ${version}"
  git push
  npm run build
  gh release create ${version} main.js manifest.json styles.css --title "${version}" --notes "..."`);

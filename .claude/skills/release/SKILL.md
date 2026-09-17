---
name: release
description: Cut a new release of the Pink Obsidian plugin, or submit it to the community plugin list for the first time. Use this whenever the user wants to release, publish, ship, tag, or bump the version of this plugin, when they ask what version a change should be, when they want to put a build in front of testers through BRAT, or when a release went out wrong and has to be fixed. Also use it when they only say "publish this" or "lança isso" inside this repo, since releasing an Obsidian plugin has rules that are easy to get wrong and hard to undo.
---

# Releasing Pink

Obsidian does not read this repository's source. It reads `manifest.json` to learn
the newest version and downloads the release assets. That single fact explains
every rule below: the release is the product, the source is just how it got made.

This also means `main.js` being in `.gitignore` is correct. It is a build result,
and its home is the release, not a commit.

## Before touching anything

Check these, and stop and tell the user if any fails instead of working around it:

```bash
git -C . status --porcelain   # must be empty
git rev-parse --abbrev-ref HEAD   # must be main
git log --oneline @{u}..HEAD      # must be empty (nothing unpushed)
npm test && npm run build         # must both pass
```

A release built from a dirty tree ships code nobody reviewed, and a release built
from an unpushed commit points a tag at a commit that only exists on this laptop.

Also check whether this is the first release at all:

```bash
gh release list
```

If the list is empty and the plugin is not in the community list yet, read
`references/first-submission.md` before going further. The first release has extra
one-time steps and their order matters.

## Step 1: pick the version

Read the commits since the last tag and decide from what they actually do:

```bash
git log --oneline $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD
```

| Bump | When | Example |
| --- | --- | --- |
| patch (`1.0.1`) | Only fixes. Nothing new to learn. | swatches not painting |
| minor (`1.1.0`) | New features, nothing breaks for current users | dark mode, wheel zoom |
| major (`2.0.0`) | Something current users relied on stops working | changing how annotations are written into the PDF so old files no longer open |

Major is rare for a plugin. The honest test is: will a person who updates lose
something, or have to redo work? If not, it is a minor.

Say which bump you picked and why in one line, then let the user correct you. This
is a judgement call about their users, not a lookup.

## Step 2: bump the version

Three files carry the version and they have to agree. Use the bundled script
rather than editing by hand, because a mismatch is the single most common way an
Obsidian release breaks and the failure is silent:

```bash
node .claude/skills/release/scripts/bump.mjs minor
node .claude/skills/release/scripts/bump.mjs minor --dry-run   # to preview first
```

It accepts `patch`, `minor`, `major`, or an exact version like `2.0.0`.

Pass `--min-app 1.7.0` only when the new code needs a newer Obsidian than before,
for instance because you started calling an API that did not exist. That writes
both `manifest.json` and a new line in `versions.json`, which is what keeps people
on older Obsidian receiving the last version that still works for them instead of
one that errors on load. If the requirement did not change, `versions.json` is
left alone on purpose.

## Step 3: commit the bump on its own

```bash
git add manifest.json package.json package-lock.json versions.json
git commit -m "chore: bump version to X.Y.Z"
git push
```

Alone, with no feature code, because the tag will point here. If code rides along
with the bump, the tag stops meaning "exactly what shipped as X.Y.Z".

## Step 4: build and create the release

```bash
npm run build
gh release create X.Y.Z main.js manifest.json styles.css \
  --title "X.Y.Z" \
  --notes "..."
```

Three things in that command are load-bearing:

- **The tag equals the manifest version, with no `v`.** `v1.1.0` makes Obsidian
  fail to find the release. This is the most frequent mistake.
- **The three files go in loose, never zipped.** Obsidian fetches each one by name.
- **Build immediately before**, so `main.js` matches the commit being tagged.

### Writing the notes

Write for someone who already uses the plugin and wants to know if updating gets
them anything. Describe behavior, not code:

```
Dark mode for the PDF page, from the toolbar or the D key.
Brush opacity, next to brush width.
Zoom with Ctrl and the mouse wheel, or a trackpad pinch.
Ctrl+F now closes the search bar too.
```

Not `adds is-dark-pdf class` or `refactors the toolbar`. Nobody installs a class
name. Pull the lines from the commits, but translate each one into what the user
will notice.

## Step 5: verify, because a bad release is public immediately

```bash
gh release view X.Y.Z
```

Confirm the tag has no `v`, all three assets are attached, and the version matches
`manifest.json`. Then tell the user it is out and that people get it through
*Settings → Community plugins → Check for updates*.

## Testing before the world sees it

When a change is risky, or touches how annotations are written to the PDF, ship it
as a pre-release first:

```bash
gh release create X.Y.Z main.js manifest.json styles.css --title "X.Y.Z" --prerelease
```

Obsidian skips pre-releases when it looks for updates, but BRAT can install one, so
testers get it and normal users do not. Drop the flag when it holds up:

```bash
gh release edit X.Y.Z --prerelease=false
```

For a local check on the user's own vault, `npm run deploy` is faster than any
release and does not touch GitHub at all.

## When something goes out wrong

Deleting a release does not unsend it, since anyone who already updated keeps what
they downloaded. So prefer moving forward.

- **Forgot an asset**: attach it, no new version needed.
  `gh release upload X.Y.Z styles.css`
- **Tag has a `v`**: delete that release and its tag, then recreate with the right
  tag. Nothing consumed it yet if Obsidian never found it.
  `gh release delete vX.Y.Z --cleanup-tag --yes`
- **Shipped a broken build**: bump a patch and release again. Rolling back is
  worse, because the version people already have would have to go backwards, and
  Obsidian only ever moves forward.
- **Version files disagree**: fix them, commit, then delete and recreate the
  release on the corrected commit.

Whatever happened, say plainly what went out and what state it is in now. A
release that is half wrong and described as fine is how someone ends up with a
corrupted PDF.

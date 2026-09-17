# Getting Pink into the community plugin list

This happens once. After the plugin is accepted, updates are just new releases and
this file stops being relevant.

Two repositories are involved. `strawndri/pink` is the plugin.
`obsidianmd/obsidian-releases` holds the list of every community plugin, and adding
an entry there is what makes Pink installable from inside Obsidian.

## The order matters

The review bot reads the plugin repo the moment the pull request opens. If the
release is not there yet it fails the check, and getting it re-run costs days of
waiting. So: repo ready, release published, pull request last.

## 1. What the repo has to have

| Requirement | Why |
| --- | --- |
| Public repo | The bot and the reviewers have to read it |
| `LICENSE` at the root | Required. Any license is fine, MIT is what most plugins use |
| `README.md` explaining the plugin | It is what people read before installing |
| `manifest.json` at the root | Where `id`, `name`, `version` and `minAppVersion` live |
| A published release | Where Obsidian downloads from |

Check the first three fast:

```bash
gh repo view --json visibility,licenseInfo,description
ls LICENSE README.md manifest.json
```

To fix visibility and description:

```bash
gh repo edit --visibility public --accept-visibility-change-consequences
gh repo edit --description "..."
```

## 2. Publish the release

Follow the main skill, steps 1 through 5. For a first submission the version is
whatever `manifest.json` already says, usually `1.0.0`, so there is nothing to bump.

## 3. Open the pull request

```bash
gh repo fork obsidianmd/obsidian-releases --clone --remote
cd obsidian-releases
git checkout -b add-pink
```

Add this to the **end** of the array in `community-plugins.json`:

```json
{
  "id": "pink",
  "name": "Pink",
  "author": "Andrieli",
  "description": "Draw, highlight and attach notes directly inside PDF files. Every annotation is written into the PDF itself - no extra notes are created in your vault.",
  "repo": "strawndri/pink"
}
```

Copy `id`, `name`, `author` and `description` straight out of `manifest.json`
rather than retyping them. The bot compares the two and any difference is a
rejection. `repo` is `owner/name`, not a URL.

```bash
git add community-plugins.json
git commit -m "Add Pink"
git push -u origin add-pink
gh pr create --web
```

`--web` because the pull request body is a checklist that has to be filled in by
hand, and a blank one gets closed.

## 4. Then it is waiting

A bot comments first with the automatic problems. After that it sits in a human
review queue, which takes days to weeks. Reviewers comment on the pull request,
and the fix goes into the plugin repo, not into the fork.

Point these out to the user ahead of time, because they are what reviewers of this
plugin are most likely to raise:

- **Styles set from JavaScript.** `src/view.ts` assigns `style.backgroundColor` on
  the palette swatches and `style.left` / `style.top` on the tool options panel and
  the note balloon. Computed positions are accepted, since CSS cannot know them.
  The swatch colour will probably get a comment, and there is a real reason for it
  being inline (commit `0cd062a`, so the colour wins against whatever the active
  theme puts on a `<button>`). Explain it in the thread instead of just reverting.
- **British spelling in the interface.** The settings tab says `Colour`. Obsidian's
  own interface is American English.
- **Attaching elements to `document.body`.** The panel and the balloon do this so
  the toolbar cannot clip them, and both are removed in `onClose`. That is fine,
  but expect to be asked about the cleanup.

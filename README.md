# PDF Ink for Obsidian

Read PDFs and mark them up inside Obsidian. Draw, highlight and write notes.

Everything you make goes into the PDF file itself, as a normal PDF annotation.
The plugin never creates a note or any other file in your vault, and the PDF
opens the same way in any other reader.

## Tools

| Tool | Key | What it does |
| --- | --- | --- |
| Select | `V` | Click an annotation to pick it, or drag a box to pick many |
| Text | `T` | Select words and copy them with `Ctrl+C` |
| Brush | `B` | Free drawing |
| Highlight | `H` | Drag over words to paint them |
| Note | `N` | Attach written text to a passage or to a spot on the page |

Pick a colour from the toolbar swatches. The last swatch is a colour picker, for
any colour outside the palette.

Hover the brush, highlight or note button and a small panel opens with the
sliders for that tool. Brush has width and opacity, highlight and note have
opacity. If something is selected, changing a colour or a slider changes it.

### The note tool

It follows what your mouse does:

- **Drag over words** and they get painted, like a highlight, with your text
  attached. Good for a comment on a passage.
- **Click once** and you get a small square marker there. Good for figures,
  tables and margins, where there is no text to select.

Either way, a box opens for you to write in.

### Reading and editing a note

Hover any annotation that has a note. A balloon opens above it with the text
inside. You can type in it, and drag the bottom corner to make it bigger. It
saves when you click away, and `Esc` closes it.

`Enter` or a double click opens the same note in a bigger window, which also has
a delete button.

## Reading

`Ctrl+F` opens the search bar, and press it again to close. `Enter` and
`Shift+Enter` walk through the matches, and the counter shows where you are.
Every match is marked on its page, and the current one is brighter.

The list button in the toolbar opens the PDF table of contents, when the file
has one. Next to it, the page box takes a number and jumps there.

Zoom with `+` and `-`, or `0` to go back to your default. `Ctrl` plus the mouse
wheel works too, and so does a trackpad pinch. The toolbar buttons do the same.

The moon button, or `D`, turns the page white on black. Images inside the PDF
are inverted too. Your choice is saved, so the next PDF opens the same way.

## Saving

Autosave writes into the PDF about a second after you stop working. `Ctrl+S`
saves right away. The bar at the bottom shows `saved`, `unsaved` or `saving`.

Only the annotations this plugin owns are rewritten. Anything else already in
the file, like links or form fields, stays untouched.

## Keys

| | |
| --- | --- |
| `V` `T` `B` `H` `N` | select, text, brush, highlight, note |
| `Ctrl+F` | open or close the search bar |
| `+` `-` `0` | zoom in, zoom out, reset (with or without `Ctrl`) |
| `Ctrl` + wheel | zoom the page |
| `D` | dark PDF on or off |
| `Ctrl+Z`, `Ctrl+Shift+Z` | undo, redo |
| `Enter`, double click | edit the note of the selected annotation |
| `Delete` | delete the selection |
| `Esc` | clear the selection |
| `Ctrl+A` | select everything on the page |
| `Ctrl+S` | save into the PDF |

## Install

```bash
git clone git@github.com:strawndri/pink.git
cd pink
npm install
npm run deploy -- /path/to/your/vault
```

Then reload Obsidian and turn **Pink** on in *Settings -> Community plugins*.

`npm run deploy` builds first. With no path it uses `$OBSIDIAN_VAULT`, then the
path saved in `.vaultpath`.

### Layout

| File | Holds |
| --- | --- |
| `src/view.ts` | The viewer: toolbar, pages, drawing, every interaction |
| `src/pdfio.ts` | Reading annotations out of a PDF and writing them back |
| `src/types.ts` | Geometry and the annotation model |
| `src/pdfjs.ts` | Thin cover over the pdf.js that Obsidian ships |
| `src/modals.ts`, `src/settings.ts`, `src/history.ts` | Note window, settings tab, undo stack |

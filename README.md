# Pink for Obsidian

Draw, highlight and take notes inside PDF files, without leaving Obsidian.

Everything you make is written into the PDF itself, as a standard PDF
annotation. The plugin never creates a note or any other file in your vault, and
the annotated PDF opens the same way in any other reader.

## Tools

| Tool | Key | What it does |
| --- | --- | --- |
| Select | `V` | Click an annotation to select it, or drag a box around several |
| Text | `T` | Select words and copy them with `Ctrl+C` |
| Brush | `B` | Freehand drawing |
| Highlight | `H` | Drag across words to paint them, one bar per line |
| Note | `N` | Attach written text to a passage or to a spot on the page |

Pick the colour from the swatches in the toolbar. The two sliders set brush
width and highlight opacity. If something is selected, changing a colour or a
slider applies to it.

### How the note tool works

It follows what your mouse does:

- **Drag across words** and they are painted, like a highlight, with your text
  attached to them. Use this to comment on a passage.
- **Click once** and you get a small square marker wherever you clicked. Use
  this for figures, tables and margins, where there is no text to select.

Either way, a box opens for you to write in.

### Reading and editing a note

Hover any annotation that carries a note. A balloon opens right above it with
the text inside. You can type in it directly, and drag its bottom corner to make
it bigger. It saves when you click away, and `Esc` closes it.

`Enter` or a double-click opens the same note in a larger window, which also has
a delete button.

## Getting around

`Ctrl+F` searches the whole document. `Enter` and `Shift+Enter` walk through the
matches, and the counter says where you are. Every match is marked on its page,
with the current one brighter.

The list button in the toolbar opens the PDF's own table of contents, when it
has one. Next to it, the page box takes a number and jumps there.

Zoom with `+` and `-`, or `0` to go back to your default. The toolbar buttons do
the same. `Ctrl+=` and `Ctrl+-` are left alone, because Obsidian uses them to
zoom the whole app.

## Saving

Autosave writes into the PDF about a second after you stop working. `Ctrl+S`
saves right away. The bar at the bottom says `saved`, `unsaved` or `saving`.

Only the annotation types this plugin owns are rewritten. Anything else already
in the file, such as links or form fields, is preserved untouched.

## Keys

| | |
| --- | --- |
| `V` `T` `B` `H` `N` | select, text, brush, highlight, note |
| `Ctrl+F` | find in document |
| `+` `-` `0` | zoom in, zoom out, reset |
| `Ctrl+Z`, `Ctrl+Shift+Z` | undo, redo |
| `Enter`, double-click | edit the note of the selected annotation |
| `Delete` | delete selection |
| `Esc` | clear selection |
| `Ctrl+A` | select everything on the current page |
| `Ctrl+S` | save into the PDF |

## Install

```bash
npm install
npm run deploy -- /path/to/your/vault
```

Then reload Obsidian and turn **Pink** on in *Settings → Community plugins*.

`npm run deploy` builds first. With no argument it uses `$OBSIDIAN_VAULT`, then
the path saved in `.vaultpath`.

## Settings

Which PDFs open in Pink, the default tool and zoom, brush and highlight
defaults, the swatch palette, and autosave with its delay.

## Develop

```bash
npm run dev     # esbuild watch
npm run build   # typecheck + production bundle
npm test        # PDF round-trip and geometry tests
```

Two more tests are kept out of `npm test` because they each need something from
you:

```bash
node test/realpdfs.mjs /path/to/a/folder/of/pdfs
node test/browser/layers.mjs    # needs firefox + geckodriver on PATH
```

The browser one loads the real `styles.css` and checks that text stays
selectable under the annotation overlay, which is what the highlight tool
depends on.

### Layout

| File | Holds |
| --- | --- |
| `src/view.ts` | The viewer: toolbar, pages, drawing, every interaction |
| `src/pdfio.ts` | Reading annotations out of a PDF and writing them back |
| `src/types.ts` | Geometry and the annotation model |
| `src/pdfjs.ts` | Thin cover over the pdf.js that Obsidian ships |
| `src/modals.ts`, `src/settings.ts`, `src/history.ts` | Note window, settings tab, undo stack |

Coordinates are stored in PDF user space, with the origin at the bottom-left of
the page, so they survive zooming and round-trip through the file unchanged.

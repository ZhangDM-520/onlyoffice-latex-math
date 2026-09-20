# LaTeX math — `$...$` to native equations for ONLYOFFICE

`https://github.com/ZhangDM-520/onlyoffice-latex-math`

An ONLYOFFICE **Document Editor** plugin that finds LaTeX source delimited by `$…$`, `$$…$$`,
`\(…\)` and `\[…\]` in the document body and replaces each span with a **native math object**
(OMML `m:oMath`), so it renders as an equation and stays editable with the equation toolbar.

## Why a plugin

ONLYOFFICE does support LaTeX, but only *inside* an equation:

| Capability | Where it lives |
| :--- | :--- |
| LaTeX as an equation input format | `Asc.c_oAscMathInputType.LaTeX` — equation settings dropdown |
| Programmatic LaTeX → equation | `Api.GetDocument().AddMathEquation(text, 'latex')` (public API, since 8.2) |
| Paste-time conversion | HTML with `class="oo-latex"`, or MathML |
| **`$...$` in the document body** | **not supported** — there is no delimiter autoconversion in this build |

So `$...$` needs an implementation, and `AddMathEquation` already produces exactly the right object.
The plugin is the smallest correct shape: no editor rebuild, no patched build.

## Install

The plugin GUID is `{5B4C1A72-3D0E-4F58-91A6-2C7E48D0B913}`. **Keep the braces** — the directory the
app enumerates is the braced one, and an unbraced copy is a silently ignored stray.

```bash
G='{5B4C1A72-3D0E-4F58-91A6-2C7E48D0B913}'

# system-wide (survives a fresh user profile; needs root)
sudo cp -a plugin/. "/opt/onlyoffice/desktopeditors/editors/sdkjs-plugins/$G/"

# or per-user (the desktop app merges both roots by GUID + version)
cp -a plugin/. "$HOME/.local/share/onlyoffice/desktopeditors/sdkjs-plugins/$G/"
```

`cp -a plugin/. <dest>` — *not* `cp -r plugin <dest>`: the latter creates `<dest>/plugin/`, and the
app then runs the previous copy without telling you.

After replacing files, quit the editor and clear its renderer cache, otherwise Chromium may keep
serving the old script:

```bash
rm -rf ~/.local/share/onlyoffice/desktopeditors/data/cache/{Cache,Code\ Cache}
```

Verify that the loaded script is the installed one (see `docs/NOTE.md` for the CDP recipe).

## Usage

* **Ribbon**: *Plugins* tab → **LaTeX math** → *Convert document* / *Convert selection* /
  *Convert selection as display math* / delimiter toggles / *Show last report*.
* **Right-click** in the body → **LaTeX math** (runs the whole-document conversion) or its submenu
  entries *Convert selection* / *Convert whole document*.
* A conversion is one undo step: a single `Ctrl+Z` restores every source span verbatim.

### Delimiters

| Source | Result |
| :--- | :--- |
| `$E=mc^2$` | inline equation |
| `$$…$$` (may span lines) | display equation |
| `\(…\)` | inline equation |
| `\[…\]` | display equation |

`\$` is an escape and never opens or closes a span. `$10`, `$20` and `\$5` stay plain text (currency
guard, switchable). Malformed spans — unterminated delimiters, whitespace-only bodies, spans across a
blank line — are **left untouched and reported**, never silently mangled.

The currency guard is deliberately not relaxed, because **nothing downstream will catch a mistake**:
`CLaTeXParser.prototype.Parse` turns any token it does not recognise into a literal character
(`word/sdk-all.js`, `GetASTTree2`), and `ApiDocument.AddMathEquation` returns `true` unconditionally
once the math element has been inserted. A wrong span is therefore deleted prose replaced by garbage
math, with no error and no rollback. Being conservative at the delimiter is the only protection there
is.

### How detection decides

Detection is deliberately biased towards *not* discarding anything:

1. **Every paragraph is scanned.** An earlier version dropped paragraphs whose range length did not
   equal their text length, on the theory that such offsets cannot be trusted. Measured on
   onlyoffice-git 9.4.0.130 that comparison is false for *every* paragraph — a range counts positions
   (interior ones can render as empty text) while `GetText()` returns characters **plus** the trailing
   paragraph mark as CRLF (2 characters for 1 position). Ordinary prose failed it, so a document
   holding `$$x=1$$` reported "Scanned: 0 paragraphs". Only a paragraph that cannot be read at all
   (`GetStartPos`/`GetRange` failing) is now set aside.
2. **Each span is verified against the live document before it is rewritten.** Every operation carries
   the source text it was planned from, and the apply step refuses any span whose range text no longer
   matches (`text-mismatch`), then checks afterwards that the source really left its own paragraph
   (`misplaced-after-insert` stops the run). A drifted offset is a reported skip, never a misplaced
   equation.
3. Offsets are read from the document snapshot and re-checked at apply time, spans are applied
   back-to-front so earlier offsets stay valid, and everything lands in one undo step.

## Report window

Each conversion records a report: the count, the spans outside the selection, malformed-delimiter
causes, any span refused at apply time, and a re-read of the document proving the delimiters are gone.
**Reports are silent by default** — open the last one on demand from *Show last report* in the ribbon
or the context menu, or turn on the *Report window* toggle to get every report as it happens. Either
way the report can be closed with the dialog's X, its footer *Close* button or `Esc`.

Settings live in the plugin's `localStorage` entry `onlyoffice-latex-math.settings` (delimiter toggles,
report behaviour). The record carries a version, so a profile written by an older build cannot keep a
behaviour that has since been silenced.

## Icons

The toolbar and menu glyphs are **Tabler icons**, rendered from the font shipped by
[noctalia](https://github.com/noctalia-dev/noctalia) rather than drawn by hand:

| Path | What |
| :--- | :--- |
| `/usr/share/noctalia/assets/fonts/noctalia-tabler.ttf` | the icon font (`noctalia-tabler-icons`) |
| `/usr/share/noctalia/assets/fonts/tabler.json` | 6000+ `name → {category, codepoint}` entries |
| `/usr/share/noctalia/assets/fonts/tabler-icons-license.txt` | **MIT**, © 2020-2025 Paweł Kuna |

The shipped PNGs are self-contained, so installing the plugin does **not** require noctalia — only
regenerating the icons does:

```bash
python tools/make-icons.py --list     # the slot -> glyph manifest
python tools/make-icons.py            # rewrite plugin/resources/** (needs Pillow + the font)
python tools/make-icons.py --check    # assert every slot exists at every scale, non-blank
```

The host resolves `…%scale%(default).png` into five keys (`100/125/150/175/200 %`) and picks the one
nearest the desktop scale, **with no fallback**: if `icon@1.25x.png` is missing the entry renders blank.
Every slot is therefore written at all five scales, and `tests/icons.test.js` fails the build if one
goes missing.

## Tests

```bash
node --test tests/          # 85 tests: scanner, icons, harness, integration, report
```

`plugin/scripts/scan.js` is the pure core (delimiter rules, offset planning) and is deliberately free
of editor API calls, so it is fully testable headlessly; `plugin/scripts/code.js` is the thin glue
that talks to the host and runs the editor commands through `Asc.plugin.callCommand`.

## Known limitations

* **Hotkey** — `Ctrl+Alt+M` (whole document) is implemented, but this build only forwards `onKeyDown`
  to plugins while a form/content-control input helper owns the keyboard, so the shortcut is
  effectively inactive. Use the menu. See `docs/NOTE.md`.
* `LaTeXParser.js` in sdkjs implements a subset of TeX, and it is **lenient**: an expression it does
  not understand is not rejected, its parts are inserted as literal characters. The delimiter rules
  are therefore the only thing standing between prose and a mangled equation — see *How detection
  decides* above.
* Live conversion *while typing* would require patching sdkjs (`RunAutoCorrect.js`) and rebuilding
  onlyoffice-git — explicitly out of scope.

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
sudo rm -rf "/opt/onlyoffice/desktopeditors/editors/sdkjs-plugins/$G"
sudo cp -a plugin/. "/opt/onlyoffice/desktopeditors/editors/sdkjs-plugins/$G/"

# or per-user (the desktop app merges both roots by GUID + version)
rm -rf "$HOME/.local/share/onlyoffice/desktopeditors/sdkjs-plugins/$G"
cp -a plugin/. "$HOME/.local/share/onlyoffice/desktopeditors/sdkjs-plugins/$G/"
```

`cp -a plugin/. <dest>` — *not* `cp -r plugin <dest>`: the latter creates `<dest>/plugin/`, and the
app then runs the previous copy without telling you.

**Remove the destination first on an upgrade.** `cp -a` only ever *adds*: a file the plugin no longer
ships (a retired icon, a deleted script) stays behind in the installed copy, so `diff -r plugin <dest>`
is the only way to see it — and the app happily loads a stale script from the leftovers. `rsync -a
--delete plugin/ <dest>/` does the same job in one step.

After replacing files, quit the editor and clear its renderer cache, otherwise Chromium may keep
serving the old script:

```bash
rm -rf ~/.local/share/onlyoffice/desktopeditors/data/cache/{Cache,Code\ Cache}
```

Verify that the loaded script is the installed one (see `docs/NOTE.md` for the CDP recipe).

## Usage

* **Right-click** on a selection → **LaTeX math**: a single row, and it converts *now*. There is no
  submenu — the selection is the unit of work, so the only question left is the one the owner has
  already answered by highlighting something.
* **`Alt+L`** does exactly the same thing (`Ctrl+A` first, if you want the whole document).
* **Ribbon**: *Plugins* tab → **LaTeX math** is a *settings* tab — *Show last report* and the five
  delimiter/report toggles. It deliberately holds no conversion entry.
* A conversion is one undo step: a single `Ctrl+Z` restores every source span verbatim.

Nothing converts the whole document behind your back: with a collapsed caret (nothing highlighted) the
plugin reports *Select the text to convert first.* and touches nothing.

### Hotkeys

| Chord | Action |
| :--- | :--- |
| `Alt+L` | *Convert selection* — the same code path as the right-click row |

The chord only exists in the Writer (`variants[0].EditorsSupport` is `["word"]`). Two things about how
it is implemented are worth knowing, because both are visible in the editor:

* **The host does not deliver chords to plugins.** The word editor calls
  `g_asc_plugins.onPluginEvent2("onKeyDown", …)` only from the `isInputHelpersPresent` branch of its key
  handler — while a form/content-control input helper owns the keyboard — and only for navigation keys.
  There is no `shortcut` field in the plugin API either. The plugin therefore installs a capture-phase
  `keydown` listener on the **editor's own document**, which it can reach because its frame is a child of
  the editor's main frame (`parent.document`).
* **A chord can arrive with its modifiers stripped.** Measured with injected keystrokes (real X11
  events into the focused window): `Alt` and `L` arrive as two events — `Alt` (`altKey: true`) and then
  `l` (`keyCode 76`, every modifier flag `false`) — and the editor would type that `l` into the
  document. So the chord is recognised from the modifier keydown that precedes it *and* from the key's
  own flags (a physical chord may well report `altKey: true`), the modifier set must match **exactly**
  (`Ctrl+L`, `Shift+Alt+L` and a plain `l` are all the editor's), and the claimed key is swallowed
  before the editor sees it. See `docs/NOTE.md` for the full event dumps.

Two consequences you may notice in use:

* **`Alt+L` on a collapsed caret does nothing visible.** It reports *Select the text to convert first.*
  and touches nothing — but reports are silent by default, so flip *Report window* on in the plugin menu
  if you want to see that.
* **If the listener cannot attach, the chord simply stops working.** A host that keeps plugins on an
  opaque origin (the shipped AI plugin loads from `onlyoffice://plugin`) cannot be reached; the plugin
  then logs `no document reached; the hotkeys are unavailable` and everything else keeps working.

### Delimiters

| Source | Result |
| :--- | :--- |
| `$E=mc^2$` | inline equation |
| `$$…$$` (may span lines) | display equation |
| `\(…\)` | inline equation |
| `\[…\]` | display equation |

`\$` is an escape and never opens or closes a span. `$10`, `$20` and `\$5` stay plain text (currency
guard, always on). Malformed spans — unterminated delimiters, whitespace-only bodies, spans across a
blank line — are **left untouched and reported**, never silently mangled. A single `$$…$$` or `\[…\]`
block may wrap across a soft line break; a blank line ends it, because the scanner sees one paragraph
at a time and a delimiter separated from its partner that way was never closed.

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
tab, or turn on the *Report window* toggle to get every report as it happens. Either
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
node --test tests/          # 105 tests: scanner, icons, hotkeys, harness, integration, report
```

`plugin/scripts/scan.js` is the pure core (delimiter rules, offset planning) and is deliberately free
of editor API calls, so it is fully testable headlessly; `plugin/scripts/code.js` is the thin glue
that talks to the host and runs the editor commands through `Asc.plugin.callCommand`.

## Known limitations

* **Hotkeys** — `Alt+L` works, but only because the plugin listens to the editor's document directly;
  the host's own plugin key event is not a shortcut channel in this build (9.4.0.130-1). A former
  `Ctrl+Alt+M` handler relied on that dead event and could never fire, so it was removed rather than
  kept as advertisement. See *Hotkeys* above and `docs/NOTE.md`.
* `LaTeXParser.js` in sdkjs implements a subset of TeX, and it is **lenient**: an expression it does
  not understand is not rejected, its parts are inserted as literal characters. The delimiter rules
  are therefore the only thing standing between prose and a mangled equation — see *How detection
  decides* above.
* Live conversion *while typing* would require patching sdkjs (`RunAutoCorrect.js`) and rebuilding
  onlyoffice-git — explicitly out of scope.

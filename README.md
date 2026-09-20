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

## Report window

Each conversion opens a report with the count, the spans outside the selection, malformed-delimiter
causes and a re-read of the document proving the delimiters are gone. Set `openReport` to `false` in
the plugin's `localStorage` entry `onlyoffice-latex-math.settings` for silent conversions. The
delimiter toggles in the menu write to the same entry.

## Tests

```bash
node --test tests/          # 60 tests: scanner, harness, integration, report
```

`plugin/scripts/scan.js` is the pure core (delimiter rules, offset planning) and is deliberately free
of editor API calls, so it is fully testable headlessly; `plugin/scripts/code.js` is the thin glue
that talks to the host and runs the editor commands through `Asc.plugin.callCommand`.

## Known limitations

* **Hotkey** — `Ctrl+Alt+M` (whole document) is implemented, but this build only forwards `onKeyDown`
  to plugins while a form/content-control input helper owns the keyboard, so the shortcut is
  effectively inactive. Use the menu. See `docs/NOTE.md`.
* `LaTeXParser.js` in sdkjs implements a subset of TeX; an unsupported expression is reported rather
  than half-converted.
* Live conversion *while typing* would require patching sdkjs (`RunAutoCorrect.js`) and rebuilding
  onlyoffice-git — explicitly out of scope.

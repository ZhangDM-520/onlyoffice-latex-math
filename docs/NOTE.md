# Engineering notes — LaTeX math plugin

Measured against **onlyoffice-git 9.4.0.130-1** (built from
`~/Projects/Gentoo_Style_Arch/packages/git/onlyoffice-git`), upstream sdkjs pinned at
`0cd3e72a8c88c512666157bb452a4ba7b4213617`.

Everything below was reproduced live in the real editor; nothing here is inferred from docs.

## 1. Host facts that decide the design

### 1.1 Menus must not be published from `Asc.plugin.init`

`AddToolbarMenuItem` sent while the host is still booting the editor is **silently dropped**: no
error, no `.ribtab`, nothing. The only plugin with a ribbon menu that ships in this build (`AI`) waits
for both `init` **and** `onTranslate` before publishing. `code.js` therefore publishes on the first of
several readiness signals (`init`, `onTranslate`, `onThemeChanged`, `onExternalMouseUp`) plus a 1500 ms
backstop, and keeps the caption update behind a `published` flag.

Symptom when this is wrong: the ribbon tab appears only after unrelated interaction, and clicking it
does nothing.

### 1.2 Context-menu items need a *checker*, and so do their children

`ButtonContextMenu.prototype.onContextMenuShow` (v1/plugins.js) copies an item into the host menu only
when

```js
a.type === this.showOnOptionsType[h] || "All" === this.showOnOptionsType[h]
```

`showOnOptionsType` starts **empty**, so an item built without `addCheckers(...)` is skipped. Known
types (`c_oPluginContextMenuTypes`) are None / Target / Selection / OleObject / Image / Shape.

The part that cost a debugging round: the host **recurses into `childs` through the same function**,

```js
if (this.childs) for (...) this.childs[m].onContextMenuShow(a, g)
```

so a parent that passes the gate while its children carry no checker produces an entry that is visible
and whose submenu is **empty** — a click on it does nothing at all. Every item in the tree
(`menuItem()` in `buildContextMenu`) declares `"All"`, and each carries its own `attachOnClick`, since
the host only attaches a click event for items that registered one.

### 1.3 Hotkeys do not reach plugins in this build

The word editor calls `g_asc_plugins.onPluginEvent2("onKeyDown", …)` only from the
`isInputHelpersPresent` branch of its key handler, i.e. while a form/content-control input helper owns
the keyboard and only for navigation keys. There is no document-level plugin shortcut, and the shipped
API has no `shortcut` field. The handler is kept (correct wherever the event arrives) but the menu and
the context menu are the working triggers.

### 1.4 Install-path traps

* The enumerated directory is the **braced** one (`{5B4C1A72-…}`); `"$SYS/$G"` with a brace-less `$G`
  creates a stray that is ignored — and leaves the old copy in place, so "my fix changed nothing".
* `cp -r plugin <dest>` nests `<dest>/plugin/` instead of overwriting.
* Chromium caches the plugin script; clear `data/cache/{Cache,Code Cache}` after installing.

## 2. Debugging recipes (all used here)

Attach to the running app with `--remote-debugging-port=9222 --remote-allow-origins=*` and talk to it
from Node over the CDP websocket. Frame contexts:

| Context | Frame |
| :--- | :--- |
| 1 | `apps/api/documents/index.html` (host API page) |
| 2 | `apps/documenteditor/main/index.html` (editor shell) |
| 4 | our plugin (`sdkjs-plugins/%7B5B4C1A72…%7D/index.html`) |

* **Is the installed script the one running?** `Debugger.getScriptSource` on the plugin frame and
  compare the byte count / a marker (`addCheckers`). This is how a stale 19825 B copy was caught while
  the repo file was 20488 B.
* **Did a click reach the plugin?** Wrap `Asc.plugin._onCustomMenuClick` and
  `Asc.plugin.event_onContextMenuClick` in the plugin frame; then drive the host dispatch directly
  from the editor frame, which is exactly what the menu does:

  ```js
  window.editor.onPluginContextMenuItemClick('asc.{5B4C1A72-…}', '<item id>')
  ```

* **What does the host receive?** The composition entry point is `Asc.plugin._events.onContextMenuShow`
  (`attachEvent("onContextMenuShow", …)` in `registerContextMenu`). Calling it with a fake
  `{ type: 1 }` payload and inspecting the resulting `AddContextMenuItem` argument shows the real
  submenu tree — `{"t":"LaTeX math","n":2}` means two children made it through the gate.
* **Creating a selection from outside** for selection-scoped tests: run Builder code in the editor
  realm through the plugin, `Asc.plugin.callCommand(function(){ Api.GetDocument().GetAllParagraphs()[0]
  .GetRange(0, n).Select(); }, …)`. `Api` does not exist in the editor page global scope — only inside
  a `callCommand` body.
* `Ctrl` cannot be delivered with `xdotool` in this XWayland setup; call the API the toolbar button
  calls instead (`window.editor.Undo()` for undo).

## 3. Verification log (live, GUI)

| Check | Result |
| :--- | :--- |
| Ribbon tab `LaTeX math` at cold start, no interaction | present; 8 items render |
| *Convert document* on a 13-`$` fixture | `Converted: 4 / 4`; `$10`, `$20`, `\$5` untouched |
| Display equation via `$$…$$` | `m:oMathPara` in the saved OOXML |
| Document right-click → *LaTeX math* → *Convert whole document* | clicked by hand, report window opened, 4/4 |
| *Convert selection* (first paragraph only) | `2 LaTeX spans found`, `Outside the selection: 2`, 2/2 converted |
| One undo after a run | all four source paragraphs restored verbatim |
| Save (`Ctrl+S`) and inspect the `.docx` | 6 `<m:oMath`, 2 `<m:oMathPara`, exactly 3 `$` left (currency + escape) |
| Reopen the saved file | equations load as native, editable math |

## 4. Test layout

`node --test tests/` → 60 tests.

* `scan.test.js` — the delimiter core: escapes, currency guard, `$$` precedence, unterminated spans,
  blank-line rejects, offset planning.
* `plugin-harness.js` — a fake browser window plus a fake editor; it mirrors the host's *gates*, not
  just the API surface: `callCommand` stays silent while the editor is "booting", `addCheckers`
  records checkers, and `composeContextMenu(type)` reproduces `onContextMenuShow` including the
  recursion into children. That last mirror is what would have caught the empty-submenu bug.
* `integration.test.js` — publication timing, backstop, caption refresh, both conversion modes.
* `report.test.js` — the report payload survives the host's URL mangling and corrupted input.

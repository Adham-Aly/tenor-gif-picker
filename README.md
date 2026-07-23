# Tenor GIF Picker

A Discord-style GIF picker that lives in the bottom-right corner of any page.

Search Tenor, click a GIF, and its link lands on your clipboard — instead of navigating you to the GIF's own page.

```
https://tenor.com/view/oh-hiiii-oh-hi-hi-hello-lizard-gif-5877185002260097302
```

On Discord it goes one better: a picked GIF is typed straight into the message box and sent.

---

## Quick start

```bash
npm install
npm run build
```

Then load it into your browser:

1. Open **`chrome://extensions`**
   _(Edge: `edge://extensions` · Brave: `brave://extensions` · Arc/Opera/Vivaldi: same pattern)_
2. Turn on **Developer mode** — top-right toggle
3. Click **Load unpacked**
4. Select the **`dist/`** folder inside this repo — **not** the repo root
5. Pin the extension so its icon is visible in the toolbar

> **Load `dist/`, not the project root.** The root has no `manifest.json`; it is the source. `npm run build` produces the loadable extension in `dist/`.

Requires **Chrome 116+** (or any Chromium browser on an equivalent base).

---

## Using it

| Action                       | How                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| **Open / close**             | <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>/</kbd>, or click the toolbar icon |
| **Open / close on Discord**  | also <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>G</kbd>                                        |
| **Search**                   | Type in the box at the top, press <kbd>Enter</kbd>                                      |
| **Copy a GIF link**          | Click any GIF. The tile confirms with **✓ Copied**                                      |
| **Favourite a GIF**          | Hover it and click the ☆ in its top-left corner                                         |
| **Open favourites**          | The ★ button in the header                                                              |
| **Close**                    | <kbd>Esc</kbd>, the ✕ button, or click outside the picker                               |
| **Resize**                   | Drag the handle in the picker's **top-left** corner                                     |
| **Get to a GIF's real page** | Right-click → _Copy link address_                                                       |

The picker opens on a local surface with your recent searches and some suggestions — zero network until you actually search.

### On Discord

Clicking a GIF **inserts the link into the message box and sends it immediately**, then closes the picker — the same flow as Discord's own picker. The link is still copied to your clipboard as a fallback, so nothing is lost if the insert ever fails.

<kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>G</kbd> opens this picker on Discord and **suppresses whatever Discord (or the browser) would otherwise do with that shortcut** — the key is intercepted on `window` in the capture phase, which runs before any handler Discord registers.

### Settings

A gear button in the header opens a settings panel. Today it holds one toggle:

**Open with Cmd+G on Discord** (on by default). When on, <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>G</kbd> toggles the picker open and closed on Discord and suppresses Discord's own GIF picker. Turn it off to hand <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>G</kbd> back to Discord — the picker still opens with <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>/</kbd>, same as everywhere else.

The close half of both shortcuts is handled inside every frame the picker owns, so a second Cmd+G reliably closes it instead of triggering the browser's find bar.

### Favourites

The star sits **outside** each tile's link, not inside it. That is what makes clicking it incapable of also copying or sending the GIF — the link is simply not on the event path, so there is no ambiguity to get wrong.

- Unfavourited stars appear on hover; **favourited stars stay visible and solid gold**, in search results and in the panel alike
- Favourites are stored locally with their thumbnail, so the panel renders without re-querying Tenor
- Clicking a favourite uses it exactly like any other GIF (copy, or send on Discord)
- State is shared through `chrome.storage`, so starring a GIF in the grid updates the panel instantly and vice versa

### Shortcuts

<kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>/</kbd> is handled by the extension on the page itself, because Chrome's `commands` API does not accept punctuation keys in a manifest. A second, fully customisable binding is registered as a real browser command (default <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>) — change it at `chrome://extensions/shortcuts`. The toolbar button always works.

One consequence of the page-level hotkey: it cannot fire on `chrome://` pages or the Web Store, where extensions may not run at all. Use the toolbar button there — or rather, note that the picker cannot appear on those pages either way.

### A deliberate detail

**Middle-click and ⌘/Ctrl-click also copy.** Inside a GIF picker, "open in a new tab" is never what you want. If you _do_ want the GIF's page, right-click → _Copy link address_ is left completely untouched as the escape hatch.

---

## Where it won't appear

- `chrome://` pages, the Chrome Web Store, PDF viewer, and other extensions' pages — Chrome forbids content scripts there, by design. The toolbar button shows a brief ✕ badge rather than doing nothing silently.
- Pages sending `Cross-Origin-Embedder-Policy: require-corp` (for example `web.whatsapp.com`). Extension frames carry no CORP header and Chrome provides no bypass. You get a clear "Can't load Tenor here" panel with an **Open Tenor in a new tab** button.

On sites with a strict `Content-Security-Policy` (GitHub, MDN, Reddit) the picker **does** work — extension-origin frames are exempt from the host page's CSP.

---

## How it works

```
┌─ any page ──────────────────────────────────────────────────┐
│  host-overlay.js  — hotkeys, Discord delivery               │
│    └─ closed shadow root in the browser's TOP LAYER         │
│         └─ <iframe src="chrome-extension://…/picker.html">  │
│              ┌─ picker.html — our chrome, our pixels ──────┐│
│              │  search · favourites · states · toast       ││
│              │  └─ <iframe src="https://tenor.com/search"> ││
│              │       ┌─ tenor.com ───────────────────────┐ │
│              │       │  tenor-frame.js @ document_start  │ │
│              │       │  click interception · stars       │ │
│              │       │  clipboard write happens HERE     │ │
│              │       └───────────────────────────────────┘ │
│              └────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
     all messages route through the service worker
```

Five things worth knowing, because they are the non-obvious parts:

**Tenor sends `X-Frame-Options: DENY`.** A `declarativeNetRequest` session rule strips that header — scoped to one header, one resource type, one tab, and only while the picker is open. Their CSP has no `frame-ancestors` directive (and that directive does not inherit from `default-src`), so removing one header is sufficient; we never touch their policy.

**The picker renders in the browser's top layer.** It is a `popover`, which paints above every other element on the page regardless of z-index or stacking context. A maximum z-index is not actually enough — it loses to any page element that also uses the maximum value and appears later in the DOM, which is why an overlay can seem to sit _behind_ page content. The top layer has no such tie to break. Every surface in the panel is also explicitly opaque, so nothing can appear to show through.

**The clipboard write happens inside the tenor frame**, synchronously in the click handler. Copying from the top frame fails silently — `document.hasFocus()` is false there, because focus is inside the iframe. The ladder is `navigator.clipboard.writeText` → `document.execCommand('copy')` → an offscreen document → a manual copy field, and it never reports success it did not get.

**Cosmetic surgery on tenor's page is an allow-list, not a deny-list.** Two selectors keep the results grid and hide everything else — nav, banners, the heading, the related-query rail — so a new promo strip on their side cannot leak into a 400px panel. A health check runs after load; if it detects that our own stylesheet has hidden the results, it removes the stylesheet and says so. An ugly picker showing real GIFs beats a beautiful empty one.

**400px is a derived number, not a guess.** Tenor's masonry picks its column count in JS: `>1100 → 4, >576 → 3, else 2`. Staying under 576 gives us their native two-column layout — Discord's exact grid shape, from their own renderer, with no CSS override. Drag the picker wider than ~600px and it snaps to three columns.

The full design rationale, including the alternatives that were rejected and why, is in [`implementation-plan.md`](./implementation-plan.md).

---

## Development

```bash
npm run build        # produce dist/
npm run watch        # rebuild on change (then hit ↻ on chrome://extensions)
npm test             # 136 unit + integration tests, no network
npm run canary       # 10 live tests against the real tenor.com
npm run check        # typecheck + lint + format + test + build
```

After a rebuild, click the **↻ reload** button on the extension's card in `chrome://extensions`. Changes to the service worker or manifest always need it; content-script changes also need the _page_ reloaded.

### Layout

```
src/
  manifest.json          hand-written on purpose — it is the security-critical surface
  background/sw.ts       DNR lifecycle, session registry, message routing
  content/
    host-overlay.ts      shadow-root host, hotkeys, Discord delivery
    tenor-frame.ts       runs inside tenor.com: guard, clicks, stars, health checks
    tenor-frame.css      the allow-list surgery (every rule scoped to our frame)
  picker/                search bar, favourites panel, state machine, feedback
  offscreen/             clipboard fallback document
  shared/                urls · click-action · clipboard · favourites · discord · messages
tests/                   unit, integration, and the live canary
```

### About the tests

Four exist to catch specific, nasty bugs:

- **`stylesheet-scope.test.ts`** parses the shipped CSS and proves every selector is scoped to our own frame. `tenor-frame.css` is manifest-declared, so Chrome delivers it to _every_ tenor.com document — one unscoped rule would silently restyle the real website for you. It includes a positive control, so it cannot pass vacuously.
- **`clipboard.test.ts`** contains a clipboard-hijack regression test. If the internal `copy` listener were registered with `{ once: true }`, a failed copy would leave it attached forever, and the next time you pressed ⌘C on your own selection you would get a GIF URL. That path only arms _after_ a failure, so no ordinary test would find it.
- **`click-action.test.ts`** runs the click policy over all 209 anchors of a real captured Tenor page, proving exactly the 49 results copy and the promoted "Upload to Tenor" tile can never produce a clipboard write.
- **`discord.test.ts`** asserts an empty message is never sent when insertion failed, and that the legacy `keyCode` Discord reads is actually present on the synthetic Enter.
- **`stylesheet-scope.test.ts` / `canary.test.ts`** together pin a subtle invariant: tenor nests the results grid _inside_ `.gallery-container > .search`, so the surgery must never `display:none` that wrapper. Hiding it once collapsed the whole grid and dumped the full tenor page — the tests now fail if any rule hides `.search`.

**`npm run canary`** is the maintenance test. It checks the real tenor.com for the things this extension depends on: that `X-Frame-Options` is still the only framing block, that no `frame-ancestors` has appeared, that their bundle still contains no frame-busting code, that the masonry thresholds are unchanged, and that our selectors still match. Run it if the picker ever starts looking wrong — it will usually name the cause.

---

## Permissions

The extension asks for **"Read and change all your data on all websites."** That is a real ask and worth understanding.

It comes from a content script that runs on every page. That script is required for the global <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>/</kbd> hotkey and for Discord delivery, both of which need code listening _before_ the picker exists. In exchange, all it does on a page it is not being used on is listen for one key combination.

Everything else stays narrow: network access is limited to `tenor.com`, there is no `tabs` permission, no `clipboardRead`, and the header-strip rule is scoped to a single tab and only armed while the picker is open.

---

## Troubleshooting

**Picker doesn't open.** Check the page isn't `chrome://`, the Web Store, or a PDF. Then open `chrome://extensions`, click **service worker** on the extension card, and look for errors.

**The hotkey does nothing on one particular site.** A page can call `preventDefault` on keys before us in rare cases. Use the toolbar button, or set a browser-level shortcut at `chrome://extensions/shortcuts`, which the page cannot intercept at all.

**Panel appears but stays empty, then shows "Can't load Tenor here."** The frame handshake never arrived. Either the host page sends COEP `require-corp` (unfixable — use the _Open Tenor in a new tab_ button), or the header-strip rule failed. Run `npm run canary`.

**GIFs show but clicking does nothing.** Open DevTools on the picker frame (right-click inside it → _Inspect_) and check the console. If you see `Couldn't copy — press ⌘/Ctrl + C`, all clipboard tiers failed and the URL is in the manual-copy field, selected and ready.

**On Discord the link is inserted but not sent.** Discord changed its composer markup. The link is still in the box — press Enter. Worth filing.

**It looks like plain tenor.com inside the panel.** The health check detected that our stylesheet had hidden the results and removed it on purpose. Run `npm run canary` to find what changed.

**Results stop at about 49 and scrolling loads no more.** Tenor server-renders the first page and fetches the rest client-side. If that request fails in a third-party frame you get the first 49. Search again for a fresh set.

---

## Verification status

**Passing:** 118 automated tests (unit + integration against a real captured Tenor page), 9 live canary tests against tenor.com, TypeScript strict typecheck, ESLint, Prettier, and a clean build.

**Not verified by automation:** anything that needs a running Chrome — the DNR rule stripping the header in a shipping build, top-layer rendering, the real clipboard write, Discord insertion against Discord's live markup, and pixel-level appearance. Loading an unpacked extension requires `chrome://extensions`, which browser automation cannot drive.

Worth walking after an update:

| #   | Check                                                             | Expected                                                                  |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Search something                                                  | Results only — no suggestion rail above the grid                          |
| 2   | Click a GIF, paste                                                | Exactly `https://tenor.com/view/…`, no `?query` string                    |
| 3   | Press Back after copying                                          | History unchanged — the click must not have navigated                     |
| 4   | Hover a GIF, click the ☆                                          | Favourited. **The GIF is not copied or sent**                             |
| 5   | Open the ★ panel, click a favourite                               | Used like any GIF; its star is solid gold                                 |
| 6   | On Discord, press <kbd>⌘</kbd>+<kbd>G</kbd>                       | Picker opens; Discord's own picker does not                               |
| 7   | On Discord, click a GIF                                           | Inserted **and sent**, picker closes                                      |
| 8   | Use it on a busy site (Notion, Gmail)                             | Nothing ever paints on top of the panel                                   |
| 9   | Click a GIF, then press <kbd>Esc</kbd>                            | Closes — focus is inside a cross-origin frame, so this is the fragile one |
| 10  | **Browse tenor.com normally, click a GIF**                        | It **navigates**, as always. The extension must not touch the real site   |
| 11  | Force a copy failure, select text in Tenor's search box, press ⌘C | You get _your_ selection, not a GIF URL                                   |

Checks 4, 10 and 11 matter most: all three are silent failures that ordinary use would not reveal.

---

## Notes

Tenor is operated by Google. Google **closed the Tenor API to third-party developers** — no new API clients since January 2026, with existing agreements terminated on 30 June 2026 — while keeping tenor.com itself fully available. That is why this extension frames the site rather than calling an API: there is no longer a sanctioned programmatic route to Tenor content.

This is built for personal use and loaded unpacked. It strips a security header (`X-Frame-Options`) from Tenor responses, narrowly scoped to one tab while the picker is open. That is worth understanding before you install it, and it would need thinking about before any wider distribution.

# Tenor GIF Picker

A Discord-style GIF picker that lives in the bottom-right corner of any page.

Search Tenor, click a GIF, and its link lands on your clipboard — instead of navigating you to the GIF's own page.

```
https://tenor.com/view/oh-hiiii-oh-hi-hi-hello-lizard-gif-5877185002260097302
```

That is the whole point: on tenor.com, clicking a search result takes you to a dedicated page for that GIF. Here, that click is intercepted and the link is copied instead.

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

Requires **Chrome 116+** (or any Chromium browser on an equivalent base). `chrome.runtime.getContexts`, used for the clipboard fallback, landed in 116.

---

## Using it

| Action                     | How                                                                           |
| -------------------------- | ----------------------------------------------------------------------------- |
| **Open / close**           | Click the toolbar icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> |
| **Search**                 | Type in the box at the top, press <kbd>Enter</kbd>                            |
| **Copy a GIF link**        | Click any GIF. The tile confirms with **✓ Copied** and a toast appears        |
| **Browse related tags**    | Click a tag chip — it searches, and keeps the search box in sync              |
| **Close**                  | <kbd>Esc</kbd>, the ✕ button, or click anywhere outside the picker            |
| **Resize**                 | Drag the handle in the picker's **top-left** corner                           |
| **Open a GIF's real page** | Right-click a GIF → _Copy link address_, or paste the copied link             |

The picker opens on a local surface showing your recent searches and some suggestions — it costs zero network until you actually search.

**Changing the shortcut:** go to `chrome://extensions/shortcuts`. Chrome silently drops a suggested binding if another extension already claimed it, so if <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> does nothing, check there. The toolbar button always works.

### A deliberate detail

**Middle-click and ⌘/Ctrl-click also copy.** Inside a GIF picker, "open in a new tab" is never what you want. If you _do_ want the GIF's page, right-click → _Copy link address_ is left completely untouched as the escape hatch.

---

## Where it won't appear

- `chrome://` pages, the Chrome Web Store, PDF viewer, and other extensions' pages — Chrome forbids content scripts there, by design. The toolbar button shows a brief ✕ badge rather than doing nothing silently.
- Pages sending `Cross-Origin-Embedder-Policy: require-corp` (for example `web.whatsapp.com`). Extension frames carry no CORP header and Chrome provides no bypass. You get a clear "Can't load Tenor here" panel with an **Open Tenor in a new tab** button.

On sites with a strict `Content-Security-Policy` (GitHub, MDN, Reddit), the picker **does** work — extension-origin frames are exempt from the host page's CSP.

---

## How it works

```
┌─ any page ──────────────────────────────────────────────────┐
│  host-overlay.js  (injected on demand via activeTab)        │
│    └─ closed shadow root, attached to <html>                │
│         └─ <iframe src="chrome-extension://…/picker.html">  │
│              ┌─ picker.html — our chrome, our pixels ──────┐│
│              │  search box · states · toast                ││
│              │  └─ <iframe src="https://tenor.com/search"> ││
│              │       ┌─ tenor.com ───────────────────────┐ │
│              │       │  tenor-frame.js @ document_start  │ │
│              │       │  capture-phase click interceptor  │ │
│              │       │  clipboard write happens HERE     │ │
│              │       └───────────────────────────────────┘ │
│              └────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
     all messages route through the service worker
```

Four things are worth knowing, because they are the non-obvious parts:

**Tenor sends `X-Frame-Options: DENY`.** A `declarativeNetRequest` session rule strips that header — scoped to one header, one resource type, one tab, and only while the picker is open. Their CSP has no `frame-ancestors` directive (and that directive does not inherit from `default-src`), so removing one header is sufficient; we never touch their policy.

**The clipboard write happens inside the tenor frame**, synchronously in the click handler. Copying from the top frame fails silently — `document.hasFocus()` is false there, because focus is inside the iframe. The ladder is `navigator.clipboard.writeText` → `document.execCommand('copy')` → an offscreen document → a manual copy field, and it never reports success it did not get.

**Cosmetic surgery on tenor's page is an allow-list, not a deny-list.** Two selectors keep the results grid and hide everything else, so a new promo strip on their side cannot leak into a 400px panel. A health check runs after load; if it ever detects that our own stylesheet has hidden the results, it removes the stylesheet and tells you. An ugly picker showing real GIFs beats a beautiful empty one.

**400px is a derived number, not a guess.** Tenor's masonry picks its column count in JS: `>1100 → 4, >576 → 3, else 2`. Staying under 576 gives us their native two-column layout — Discord's exact grid shape, from their own renderer, with no CSS override. Drag the picker wider than ~600px and it snaps to three columns.

The full design rationale, including the alternatives that were rejected and why, is in [`implementation-plan.md`](./implementation-plan.md).

---

## Development

```bash
npm run build        # produce dist/
npm run watch        # rebuild on change (then hit ↻ on chrome://extensions)
npm test             # 92 unit + integration tests, no network
npm run canary       # 9 live tests against the real tenor.com
npm run check        # typecheck + lint + format + test + build
```

After a rebuild, click the **↻ reload** button on the extension's card in `chrome://extensions`. Changes to the service worker or manifest always need it; content-script changes also need the _page_ reloaded.

### Layout

```
src/
  manifest.json          hand-written on purpose — it is the security-critical surface
  background/sw.ts       DNR lifecycle, session registry, message routing
  content/
    host-overlay.ts      shadow-root host on the page; owns geometry + open/close
    tenor-frame.ts       runs inside tenor.com: guard, click interception, health checks
    tenor-frame.css      the allow-list surgery (every rule scoped to our frame)
  picker/                our search bar, state machine, copy feedback
  offscreen/             clipboard fallback document
  shared/                urls · click-action · clipboard · messages · constants
tests/                   unit, integration, and the live canary
```

### About the tests

Two are worth calling out because they exist to catch specific, nasty bugs:

- **`tests/stylesheet-scope.test.ts`** parses the shipped CSS and proves every selector is scoped to our own frame. `tenor-frame.css` is manifest-declared, so Chrome delivers it to _every_ tenor.com document — one unscoped rule would silently restyle the real website for you. The test includes a positive control, so it cannot pass vacuously.
- **`tests/clipboard.test.ts`** contains a clipboard-hijack regression test. If the internal `copy` listener were registered with `{ once: true }`, a failed copy would leave it attached forever, and the next time you pressed ⌘C on your own selection you would get a GIF URL. That path only arms _after_ a failure, so no ordinary test would find it.

**`npm run canary`** is the maintenance test. It checks the real tenor.com for the things this extension depends on: that `X-Frame-Options` is still the only framing block, that no `frame-ancestors` has appeared, that their bundle still contains no frame-busting code, that the masonry thresholds are unchanged, and that our selectors still match. Run it if the picker ever starts looking wrong — it will usually name the cause.

---

## Troubleshooting

**Picker doesn't open.** Check the page isn't `chrome://`, the Web Store, or a PDF. Then open `chrome://extensions`, click **service worker** on the extension card, and look for errors.

**Panel appears but stays empty, then shows "Can't load Tenor here."** The frame handshake never arrived. Either the host page sends COEP `require-corp` (unfixable — use the _Open Tenor in a new tab_ button), or the header-strip rule failed. Run `npm run canary`; if the `frame-ancestors` test fails, Tenor has changed something fundamental.

**GIFs show but clicking does nothing.** Open DevTools on the picker frame (right-click inside it → _Inspect_) and check the console. If you see `Couldn't copy — press ⌘/Ctrl + C`, all clipboard tiers failed and the URL is sitting in the manual-copy field, selected and ready.

**It looks like plain tenor.com inside the panel.** The health check detected that our stylesheet had hidden the results and removed it on purpose. You should also see a note saying so. Run `npm run canary` to find what changed.

**Results stop at about 49 and scrolling loads no more.** Tenor server-renders the first page and fetches the rest client-side. If that request fails in a third-party frame, you get the first 49 and nothing else. Search again to get a fresh set.

---

## Verification status

Everything below is genuinely checked, and I want to be precise about what is not.

**Passing:** 92 automated tests (unit + integration against a real captured Tenor page), 9 live canary tests against tenor.com, TypeScript strict typecheck, ESLint, Prettier, and a clean build.

**Not verified:** the extension has **not been exercised in a running Chrome**. Browser automation was unavailable in the environment where this was built, and loading an unpacked extension requires `chrome://extensions`, which automation cannot drive anyway. Everything involving the actual browser — the DNR rule stripping the header in a shipping build, the frame rendering, the real clipboard write, and pixel-level appearance — rests on Chromium source analysis and unit-level tests, not on observed behaviour.

So please walk this once after loading it:

| #   | Check                                                                     | Expected                                                                                   |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Open on `example.com`, search `cat`                                       | Two-column grid, 400×540, bottom-right, 20px from each edge                                |
| 2   | Click a GIF, paste somewhere                                              | Exactly `https://tenor.com/view/…`, no `?query` string                                     |
| 3   | Press the browser Back button after copying                               | History unchanged — the click must not have navigated                                      |
| 4   | Click a tag chip                                                          | Searches, **and** the search box updates to match                                          |
| 5   | Click a GIF, then press <kbd>Esc</kbd>                                    | Closes. This is the one most likely to break, because focus is inside a cross-origin frame |
| 6   | Repeat on **github.com**                                                  | Works, or shows the recovery panel — never a blank white box                               |
| 7   | **Browse tenor.com normally and click a GIF**                             | It **navigates**, as always. The extension must not touch the real site                    |
| 8   | Scroll past result 49                                                     | More results load                                                                          |
| 9   | Force a copy failure, then select text in Tenor's search box and press ⌘C | You get _your_ selection, not a GIF URL                                                    |
| 10  | Use it on site A, then site B                                             | The Tenor ToS/language banners never appear on either                                      |

Checks 7 and 9 matter most: both are silent failures that no amount of happy-path use would reveal.

---

## Notes

Tenor is operated by Google. Google **closed the Tenor API to third-party developers** — no new API clients since January 2026, with existing agreements terminated on 30 June 2026 — while keeping tenor.com itself fully available. That is why this extension frames the site rather than calling an API: there is no longer a sanctioned programmatic route to Tenor content.

This is built for personal use and loaded unpacked. It strips a security header (`X-Frame-Options`) from Tenor responses, narrowly scoped to one tab while the picker is open. That is worth understanding before you install it, and it would need thinking about before any wider distribution.

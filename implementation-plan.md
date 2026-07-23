# Tenor GIF Picker — Chrome Extension Implementation Plan

**Status:** Planning complete. No code written. Awaiting go-ahead on Phase 0.
**Date:** 2026-07-22
**Authors:** Planned adversarially by three Opus 4.8 agents (Architect / RedTeam / UXFallback), synthesized by the lead.
Raw debate artifacts live in the session scratchpad (`00-seed-facts.md`, `01-architect.md`, `02-redteam.md`, `03-ux-fallback.md`).

---

## 1. What we are building

A Chrome extension (MV3) that overlays a Discord-style GIF picker in the **bottom-right corner of any page**. The picker contains a live `tenor.com` search experience in an iframe. **Clicking a GIF copies its canonical link to the clipboard instead of navigating** — e.g. `https://tenor.com/view/oh-hiiii-oh-hi-hi-hello-lizard-gif-5877185002260097302`.

### Verdict up front

**The design is feasible as specified.** A dedicated red-team agent set out to kill it and could not. Every candidate blocker was investigated against primary sources and closed:

| Threat                                   | Status                            | Evidence                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenor JS busts out of frames             | **DEAD**                          | 19 framebust patterns × 377KB bundle + 194KB inline scripts + all 3 `createElement("script")` sites → zero hits                                                                                |
| Host page CSP blocks our iframe          | **DEAD**                          | Two independent Chromium bypass mechanisms, both source-verified (§5.2)                                                                                                                        |
| Tenor breaks without third-party cookies | **DEAD for the first 49 results** | SSR works cookieless (49 results, zero cookies). _Scope limit:_ the CORS-XHR evidence covers the client-side path, which under the recommended design is only reached on **scroll** — see §5.5 |
| GDPR/consent wall eats the frame         | **MOSTLY DEAD**                   | Zero CMP framework (`__tcfapi`, OneTrust, Didomi, …) anywhere in bundle or HTML                                                                                                                |
| DNR can't strip XFO before the XFO check | **DEAD**                          | 10-step trace: the header strip mutates the exact `HttpResponseHeaders` object the throttle later reads (§5.1)                                                                                 |
| HTTP cache serves un-stripped headers    | **DEAD**                          | Cache sits _below_ the extension proxy; every read is re-stripped                                                                                                                              |

**The one problem with no engineering answer is a product question, not a technical one** — see §3, Question 1.

---

## 2. Architecture

```
┌─ host page (github.com, arbitrary CSP) ──────────────────────────┐
│  host-overlay.js  — injected on demand via activeTab             │
│    └─ #picker-host  [closed shadow root, on documentElement]     │
│         └─ <iframe src="chrome-extension://…/picker.html"        │
│                    allow="clipboard-write">        ← CSP-EXEMPT  │
│              ┌─ picker.html — our document, our pixels ─────────┐│
│              │  search input · close · toast · error states     ││
│              │  └─ <iframe src="https://tenor.com/search/…"     ││
│              │             allow="clipboard-write">             ││
│              │       ┌─ tenor.com — XFO stripped by DNR ──────┐ ││
│              │       │  tenor-frame.js @ document_start       │ ││
│              │       │  capture-phase click interceptor       │ ││
│              │       │  execCommand('copy')  ← CLIPBOARD HERE │ ││
│              │       └────────────────────────────────────────┘ ││
│              └─────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
   all control messages: chrome.runtime.* → service worker (sole arbiter)
```

**Why nest an extension frame rather than putting the tenor iframe straight in the page?** Not for CSP — a flat design also survives (§5.2). The picker needs **a document we own**: somewhere to put our chrome, our error state when the tenor frame fails to load, and the last-resort "here's the URL, press ⌘C" field. In a flat design that markup lands in the _host page's_ DOM, where it inherits the host's Trusted Types policy (`mail.google.com` ships `require-trusted-types-for 'script'`), fights host CSS, and is reachable by host JS. The flat design remains a legitimate fallback; migration is contained to `picker.html` becoming a shadow-DOM subtree.

---

## 3. Questions for you

None of these block Phase 0. Each has a stated default and a cheap reversal.

### Question 1 — Whose search bar? _(the one that changes what you see on day one)_

Your spec said _"the tenor.com page with the search bar at the top (like a gif picker would have)."_ Two readings:

- **(a) Tenor's own search box**, visible inside the frame. Literal reading. Gets their autocomplete dropdown free, and search runs through their SPA router (no reload).
- **(b) Our own search input** in our chrome, driving `iframe.src`. Full visual control, real Discord parity, our focus ring, our dark mode, recent searches.

**Recommendation: (b), ~90% confidence.** The deciding fact: tenor's form has **no `action`, no `method`, and no `<button>`** — search is pure client-side JS routing. Under (a) we are a _passenger_: we cannot read the query, keep our own state in sync, offer recents, or recover if their handler changes. The one thing (b) costs — a white flash on reload — is already neutralized by machinery we need anyway (skeleton + opacity gate until the frame handshakes).

_Wrong guess costs an afternoon, not a rewrite — ~90% of the machinery is shared._

### Question 2 — What do you want on open, before you've searched?

Tenor trending (Discord's feel, ~250KB every open) or an instant local surface with recent searches (faster, cheaper, and the first thing you see is our pixel-perfect UI rather than a load). **Default: the instant local surface.**

### Question 3 — Auto-close after copy?

**Default: stay open.** Copying isn't terminal the way sending is in Discord — "wrong one, try again" is a real flow, and auto-closing destroys the confirmation moment. Counter-argument is genuinely strong though: your next action is probably to paste into the page the picker is now covering. _Close to a coin flip; ships as a setting either way._

### Question 4 — Dark mode?

tenor.com is **light-only** (verified: zero `prefers-color-scheme`, zero `.dark` in their 137KB stylesheet). Since our CSS surgery strips their chrome down to a background, tiles and a scrollbar, theming the frame's interior is ~10 declarations. **Default: theme both, follow `prefers-color-scheme`.** The one combination that must never ship is dark chrome around a hard-white frame — it reads as broken.

### Question 5 — Heads-up, no action needed: the Tenor API situation changed

Google **closed the Tenor API to third parties** — no new clients since 2026-01-13, third-party agreements terminated 2026-06-30 (three weeks ago). tenor.com the website is explicitly staying up with full search, so **this plan is unaffected**. But it means:

- There is no longer any _sanctioned_ programmatic route to Tenor. The "just use the official API" alternative that would normally be the safe fallback **no longer exists as an option we can legitimately take**.
- We are building a third-party surface on a property Google spent 2026 closing to third parties.

_Your call whether that risk profile is acceptable before investing. It does not change the build._

> **A conflict in the research, now resolved from the primary source.** Architect got a live `HTTP 200` from `tenor.googleapis.com/v2` today, which looks like it contradicts the shutdown. It doesn't — that probe used **tenor.com's own embedded first-party key** (base64'd into every page they serve), which naturally still works because their own website runs on it. A live 200 is what the shutdown _predicts_, not a contradiction: the developer program closed, and tenor.com necessarily still calls its own backend with a first-party key.
>
> 🚫 **Explicit prohibition — do not use tenor's embedded key.** This plan now documents that `API_V2_KEY` is a base64 decode away, so "just use tenor's key" will look like a free win to whoever runs Phase 0. It is not. It is **credential misuse** — categorically different from framing or scraping, and it _inverts_ the ToS argument in the Appendix that makes framing defensible. It is also rotatable at Google's whim, likely referrer-blocked from a `chrome-extension://` origin anyway, and a genuine Web Store risk. Closing this now so it isn't rediscovered as a shortcut later.
>
> Confirmed directly from `developers.google.com/tenor/guides/quickstart` (fetched 2026-07-22), which carries a site-wide banner — _"Tenor API Service Discontinuation: Please read the update regarding the Tenor API for more information."_ — and states inline:
>
> > _"As of Jan 2026, we are no longer accepting new API clients. The following instructions are for reference only."_
>
> **No sanctioned API path is obtainable by us.** This is verified, not inferred. It is why Tier 3 in the appendix is HTML scraping rather than an API client.

---

## 4. Decisions, with dissent recorded

| #   | Decision                                                                                                                                                                     | Rationale                                                                                                                                                                                                                                                                                                                                                           | Dissent                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Nested** extension frame containing the tenor frame                                                                                                                        | Need a document we own for chrome + error UI + clipboard tier 4                                                                                                                                                                                                                                                                                                     | RedTeam: flat works. True, but doesn't provide the UI document. Flat kept as fallback.                                                                                        |
| D2  | Clipboard: **`writeText` first, `execCommand` second** — both in the tenor frame, synchronously in the click handler                                                         | **Settled by an argument neither side made initially:** `writeText` is _side-effect-free_, whereas `execCommand` injects a `<textarea>` into a third-party document and clobbers the user's selection there. Paying that cost on every click to dodge a failure that only fires when a host page ships `Permissions-Policy: clipboard-write=()` is the wrong trade. | Reversed mid-planning. Architect initially argued `execCommand` first (strictly fewer gates — true), then conceded on the side-effect argument. Both agents now agree.        |
| D3  | `allow="clipboard-write"` on **both** iframes                                                                                                                                | Mandatory for the `writeText` tier — isolated worlds get a CSP exemption but **no** Permissions Policy exemption                                                                                                                                                                                                                                                    | None — RedTeam and Architect converged independently                                                                                                                          |
| D4  | **`activeTab` + tenor-only host permissions**, not `<all_urls>`                                                                                                              | Install warning becomes _"Read and change your data on tenor.com"_ instead of _"…on all websites"_. Both entry points (toolbar click, `commands` shortcut) grant `activeTab`                                                                                                                                                                                        | None. This retires one of the main stated costs of the in-page overlay.                                                                                                       |
| D5  | DNR rule is **session-scoped + tab-scoped + open/close-scoped**                                                                                                              | `tabIds` is session-rules-only. Blast radius shrinks from "tenor is framable by everyone, forever" to "…in one tab, while the picker is open"                                                                                                                                                                                                                       | None                                                                                                                                                                          |
| D6  | **Allow-list** click interception — one interceptor, **two verbs**: `/view/` → copy, `/search/` → relay the query up to our search state. Everything else navigates normally | 142 of 209 anchors are `/search/` chips; a blanket `preventDefault` breaks 74% of the page including search itself. But _ignoring_ `/search/` is also wrong — it desyncs our search box from what the frame is showing (§7.5)                                                                                                                                       | None                                                                                                                                                                          |
| D7  | Intercept plain, modified **and** middle clicks — always copy                                                                                                                | Inside a GIF picker, "open in new tab" is never the goal. Right-click → "Copy link address" is deliberately left intact as the escape hatch: it resolves to the absolute URL, so it yields exactly the right string, and it's discoverable by convention                                                                                                            | UXFallback wanted ⌘/middle-click preserved, then **withdrew** on the contextmenu argument. Settled — but since it's now our _only_ escape hatch, Phase 0 confirms it survives |
| D8  | CSS surgery is an **allow-list**, not a deny-list                                                                                                                            | A deny-list _fails open_ — the day tenor ships a new promo strip it appears in our picker. An allow-list _fails closed_                                                                                                                                                                                                                                             | None                                                                                                                                                                          |
| D9  | Picker geometry: **400 × 540**, bottom-right, 20px offsets                                                                                                                   | Derived, not guessed — see §6                                                                                                                                                                                                                                                                                                                                       | None                                                                                                                                                                          |
| D10 | All IPC over **`chrome.runtime`**, never `window.postMessage`                                                                                                                | Decisive: `postMessage` from the tenor frame is indistinguishable from tenor's own page scripts (identical origin), so a compromised script could forge a picked-URL message → **clipboard poisoning**. `chrome.runtime` sender identity is browser-asserted                                                                                                        | None                                                                                                                                                                          |
| D11 | TypeScript + esbuild, no UI framework                                                                                                                                        | Real risk surface is message passing across 4 isolated contexts → discriminated-union message types. The "grid" is an iframe; there's no state tree to justify React. Manifest stays hand-written because it _is_ the security-critical surface                                                                                                                     | UXFallback would accept `wxt`; not worth the manifest abstraction here                                                                                                        |

---

## 5. Load-bearing verified facts

Restate these in code comments; they are the foundation and each was expensive to establish.

### 5.1 DNR strips XFO _upstream_ of the XFO check — the crux

`x-frame-options: DENY` is the **only** header-level framing block (tenor's CSP has no `frame-ancestors`, and that directive does **not** fall back to `default-src`). So we remove one header rather than mangling a third party's whole policy.

The ordering question was existential: DNR modifies headers in the network path, but `AncestorThrottle` enforces XFO during navigation. **The mechanism is not the obvious one**, and the team's first answer was wrong in an instructive way.

`AncestorThrottle` does **not** read the raw response headers. It reads a pre-parsed struct — `ancestor_throttle.cc:258` → `request->response()->parsed_headers->xfo`. (`GetResponseHeaders()` appears in that file only inside `if (logging == LoggingDisposition::LOG_TO_CONSOLE)` — the console-message path, not the decision path.) So "we removed the raw header" does not, on its own, imply the throttle sees the change.

It works because of an **explicit conditional reparse** in `web_request_proxying_url_loader_factory.cc:1137-1172`:

```cpp
current_response_->headers = override_headers_;
// The extension modified the response headers without specifying the
// 'extraHeaders' option. We need to repopulate the ParsedHeader to reflect
// the modified headers.
// TODO(crbug.com/40765899): … remove this code.
// Note: As an optimization, we reparse the ParsedHeaders only for navigation
// and worker requests, since they are not used for subresource requests.
switch (factory_->loader_factory_type()) {
  case URLLoaderFactoryType::kDocumentSubResource: … ContinueToResponseStarted(); return;  // NO reparse
  case URLLoaderFactoryType::kNavigation: … break;                                          // reparse
}
```

An iframe load is a navigation → `kNavigation` → ParsedHeaders regenerated **from the DNR-mutated raw headers** → the throttle reads `parsed_headers->xfo == kNone`. **Conclusion holds; mechanism is a reparse, not object identity.**

Also confirmed: `sub_frame` is not excluded from response-header modification (navigations are explicitly proxied), and DNR has **no protected-security-header blocklist** — `x-frame-options` is an ordinary header to it.

> ⚠️ **WATCH ITEM — the single most dangerous line in this design.** That reparse is labelled an _optimization_ and carries `TODO(crbug.com/40765899)` proposing to migrate these headers to require `extraHeaders` and **delete this code**. If that lands and DNR `modifyHeaders` is not treated as `extraHeaders`, the reparse stops, `parsed_headers->xfo` reverts to `kDeny`, and **the picker goes blank — silently, on a Chrome auto-update, with no change on our side.** This is precisely why the runtime handshake in §7.7 is mandatory rather than nice-to-have: no test we run on our machine can catch a regression that ships with the user's browser.

**Cache hits:** the HTTP cache lives _below_ the network-service `URLLoader`, so cached responses re-enter the proxy and are re-stripped on every read. **Do not cache-bust** — it would only cost a 250KB refetch per search.

### 5.2 Host-page CSP does not block us — two independent mechanisms

> ⚠️ **This one was contested inside the team and the first answer was wrong.** RedTeam grepped `extensions/renderer/dispatcher.cc`, found no CSP-bypass registration, and concluded the well-known "`chrome-extension:` is a CSP-bypassing scheme" claim was folklore. Architect then found the registration — it **moved** to the content-client layer and is consumed by the network service. Both mechanisms are real.

- **Mechanism A — scheme bypass.** `chrome/common/chrome_content_client.cc:254` does `schemes->csp_bypassing_schemes.push_back(extensions::kExtensionScheme)`. `frame-ancestors` is the _sole_ directive this cannot bypass (explicitly, with a comment citing crbug.com/1115590) — and that's about _us being embedded_, not _us embedding_.
- **Mechanism B — isolated-world attribution.** `frame_loader.cc:974` skips main-world CSP for navigations initiated from an isolated world; MV3 content scripts always have a registered isolated-world CSP, and it contains no `frame-src`.

**These are not redundant coverage of the same thing — they guard different designs.** Mechanism A tests `InnermostScheme(url)`, i.e. _the URL being loaded_:

| Design                 | Frame URL                          | Mechanism A          | Mechanism B                                               |
| ---------------------- | ---------------------------------- | -------------------- | --------------------------------------------------------- |
| **Nested** outer frame | `chrome-extension://…/picker.html` | ✅ applies           | ✅ applies                                                |
| **Nested** inner frame | `https://tenor.com/…`              | ❌ scheme is `https` | n/a — different document; the host's CSP never reaches it |
| **Flat**               | `https://tenor.com/…`              | ❌ scheme is `https` | ✅ **sole protection**                                    |

So the nested design (D1) is genuinely more robust than it first appeared: its outer frame is protected browser-side _and_ renderer-side, and its inner frame sits outside the host's CSP scope entirely. A flat design rests **solely** on the isolated-world path — which is marked `Deprecated` in source, carries a TODO to remove it, and has the two fragility rules below.

⚠️ **Anyone later "simplifying" nested → flat silently trades a belt-and-braces guarantee for a single deprecated one. This belongs in a code comment, not tribal knowledge.**

**Two hygiene rules that forfeit Mechanism B if broken** — cheap to follow, miserable to debug (they fail _only_ on strict-CSP sites):

- ❌ Never `loading="lazy"` on either iframe. Lazy loading short-circuits before the `FrameLoadRequest` is built, losing world attribution.
- ❌ Never create the iframes from a MAIN-world injected script. Content script's isolated world only.

### 5.3 Clipboard gating

|                                      | `navigator.clipboard.writeText()`                                   | `document.execCommand('copy')`            |
| ------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------- |
| Permissions Policy `clipboard-write` | **required** (default allowlist `self`, not inherited cross-origin) | not consulted                             |
| Focus check                          | `document.hasFocus()` — document-level                              | not consulted                             |
| User activation                      | required                                                            | required (or `clipboardWrite` permission) |

They fail on **different conditions**, which is what makes this a real fallback chain rather than two shots at the same failure.

**Two designs that look obvious and fail silently:**

- ❌ Copy in the **top frame**. `document.hasFocus()` is false — focus is inside the iframe. Rejects with `NotAllowedError`, unhandled, user sees nothing.
- ❌ `chrome.offscreen` + `navigator.clipboard`, _despite `reason: "CLIPBOARD"` naming this exact use case_. Offscreen documents can never be focused. (Offscreen + `execCommand` **does** work and is what Google's own sample uses.)

The `clipboardWrite` permission grants precisely one thing: it lets `execCommand('copy')` succeed **without** user activation in extension contexts. It does not waive Permissions Policy, does not waive the focus check, and does not expose `navigator.clipboard` to the service worker.

### 5.4 Tenor page facts

- Results are **server-rendered** into the initial HTML (~49 `/view/` anchors per search page). First paint is already results.
- Anchor census: **209 total — 142 `/search/`, 49 `/view/`**, rest misc.
- Search form: `<form class="SearchBar">` with **no `action`/`method`/`<button>`**. Client-side routing via `pushState`.
- **Masonry column count is decided in JS, not CSS:** `containerWidth > 1100 ? 4 : > 576 ? 3 : 2`.
- Class names are **semantic, not hashed** (`NavBar`, `TopBar`, `Banner`, `UniversalGifList`) — selectors survive ordinary redeploys.
- `.BaseApp` has exactly **7 direct children**; only `.SearchPage` is wanted.
- tenor.com is **light-only**. No dark mode exists to inherit.
- **There is one promoted "Upload to Tenor" tile per search page**, injected _inside_ the grid at `data-index="16"`. It reuses `.UniversalGifListItem` and is not distinguishable by class. Clicking it would copy nothing — a correctness bug, not just cosmetic (§7.5).

### 5.5 ⚠️ Pagination — the gap every analysis missed

**All three agents overlooked this, and it is the defect most likely to reach production with every check green.**

SSR delivers page 1 — 49 results — **plus a pagination cursor**. Tenor embeds it in the page:

- `#data` (base64 JSON) → `API_V2_URL: https://tenor.googleapis.com/v2`, `API_V2_KEY`, `API_V2_CLIENT_KEY: tenor_web`
- `#store-cache` (JSON) → `.universal.search.<query>.next = "CDIQgciT_9bnlQMaHgoKAD-…"` — a v2 cursor, server-rendered into the page
- `onScroll` present in the bundle; `IntersectionObserver` absent → scroll-handler-driven load-more

**So everything past result 49 is a live client-side call to `tenor.googleapis.com/v2` from inside our partitioned third-party frame.**

**The failure mode is the dangerous kind:** the user scrolls, results silently stop at ~49. No error, no empty state — and **H1–H4 all pass**, because 49 results genuinely rendered. Infinite scroll is a core picker interaction, so this would present as "the picker just kind of stops" with every health check green.

_It may well work_ — the frame's origin is still `https://tenor.com` inside a third-party iframe, so CORS should pass exactly as it did in the standalone probe. But it is **unverified on the real code path**, and the cost of being wrong is a silent truncation. **Phase 0 closes it in 30 seconds** (scroll to bottom, assert results arrive past 49).

**This strengthens Question 1's recommendation.** Under option (b) with `src` navigation, every search is a fresh SSR load, so the first 49 results always come from the cookieless-verified path and the API is only reached on scroll. Under option (a), `pushState` routing renders searches client-side — making even _primary_ results API-dependent.

---

## 6. UI specification

### Geometry — derived from tenor's own code, not guessed

The masonry threshold above is the key: **any frame ≤576 CSS px content width renders tenor's native 2-column masonry — which _is_ the Discord picker layout.** We get the single most important visual property free, from tenor's own renderer, with zero CSS override.

| Token          | Value                                                                 | Why                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Width          | **400px**                                                             | Content lands ~370px → comfortably under 576 → 2 columns, tiles ~175px                                                                                    |
| Height         | **540px**                                                             | ~488px of grid after a 52px header ≈ 3 masonry rows                                                                                                       |
| Clamp          | `max-width: calc(100vw - 24px)`, `max-height: calc(100vh - 24px)`     | Small viewports, high zoom. Non-negotiable                                                                                                                |
| Offset         | `right: 20px; bottom: 20px`                                           | 16px reads tight against arbitrary page furniture                                                                                                         |
| Radius         | 12px                                                                  | Harmonises with tenor's 5px tiles                                                                                                                         |
| Elevation      | `0 12px 32px rgba(0,0,0,.24), 0 2px 8px rgba(0,0,0,.12)`              | Contact + ambient                                                                                                                                         |
| **Hairline**   | `1px solid rgba(0,0,0,.08)`                                           | **Critical.** tenor's page is `#fff`; a white picker on a white host page with only a shadow reads as a smudge. The hairline is what makes it a _surface_ |
| Stacking       | `z-index: 2147483647` on the shadow host                              | Host pages fight dirty                                                                                                                                    |
| Open           | 140ms `cubic-bezier(.16,1,.3,1)`, `scale(.96)→1`, `translateY(8px)→0` | Transform origin `bottom right` — it must grow out of the corner it lives in                                                                              |
| Close          | 100ms `ease-in`, reverse                                              | Closing should feel quicker than opening                                                                                                                  |
| Reduced motion | opacity only, 100ms                                                   | tenor's own CSS already respects this; we match                                                                                                           |

**Mount:** closed shadow root on a host element attached to `document.documentElement` — **not `body`**. Dodges host stacking contexts, and survives SPA frameworks that replace `body`. An ancestor with `transform`/`filter`/`contain` becomes the containing block for `position: fixed`, which is the main residual hostile-layout risk; `MutationObserver` re-appends if the host is torn out.

**Pixel details that are easy to miss:**

- `iframe { display: block; border: 0 }` — an inline-level iframe inherits the line box and produces a ~4px phantom seam at the bottom.
- Set `color-scheme` so native controls and the frame's scrollbar render correctly.
- Style the in-frame scrollbar (`scrollbar-width: thin`) — left alone, Windows renders a chunky light scrollbar inside our rounded corner.
- The iframe's square corners poke out of the 12px radius: `overflow: hidden` on the clipper, possibly `transform: translateZ(0)` to force correct corner rasterisation.
- **Use a system font stack; do not fetch Inter to match tenor's type.** A webfont is a network dependency and a CSP surface for a 52px header, and the mismatch is invisible at this size. This is a trap someone will walk into later while chasing pixel parity.

**Resizable: yes, one handle, top-left, size persisted.** Justification isn't "Discord has it" — it's that dragging past ~600px makes **tenor itself** relayout to 3 columns. Note honestly that this is a _discontinuous_ relayout, so the drag visibly snaps. **Draggable: no** — the spec says bottom-right; dragging buys a "where did it go" class of bug. _This is the one piece of scope to defer to v1.1 if needed._

### The Esc trap — and why the shortcut ships in v1

When focus is inside the tenor iframe, `keydown` fires in _tenor's_ cross-origin document. It does not bubble to us and we cannot listen for it. **A naive implementation has an Esc key that silently stops working the moment the user clicks anything in the grid** — i.e. always, since clicking the grid is the entire product.

Fix, free because we already have a script in the frame: the in-frame script listens for Escape and relays `{type:'dismiss'}`. Plus the `chrome.commands` shortcut is handled by the _browser_ before any page sees it, so it toggles regardless of focus. That is a real reason to ship the shortcut in v1, not treat it as a nicety.

Outside-click: listen on `pointerdown`, **capture phase** (a host page that `stopPropagation()`s `click` can't trap us), and use `composedPath()` for containment or the shadow root reads as "outside" and the picker closes on its own chrome.

Suggested shortcut: **`Alt+Shift+G`** — most obvious bindings collide (`Cmd+Shift+G` is find-previous nearly everywhere).

**Focus restoration on close is not an accessibility nicety here — it is the core loop.** The flow this extension exists to serve is _copy → close → paste_. If closing doesn't return focus to the element the user was in, the paste target is gone and two steps become four, in the one flow that matters. Store `document.activeElement` on open, restore it on close. **It must also fire on the relayed `dismiss` path** from the Esc trap above, which is the case that will get missed.

### The copy moment — this is the product

**Discoverability first.** The user's mental model, trained by every GIF grid on the internet, is _click → navigate_. We're changing the verb. On tile hover (100ms fade): subtle scrim + glyph + **"Click to copy link."** This replaces the fav/share buttons we hide, so hover still has an affordance.

**Confirmation renders on the clicked tile, in the frame** — non-negotiable. The click happened inside the iframe and the user's eye is on that tile; confirming only in our header is up to 480px of eye travel to find out whether it worked. Our chrome shows a secondary, redundant toast.

| t (ms) | Event                                                                               |
| ------ | ----------------------------------------------------------------------------------- |
| 0      | `pointerdown` → tile `scale(.97)`, 60ms. Immediate tactile ack                      |
| 0      | `click` intercepted, capture phase → `preventDefault()`. Clipboard write dispatched |
| ~10–20 | Success → scrim `rgba(0,0,0,.55)` + centred checkmark, 120ms fade                   |
| +160   | "Link copied" toast in our chrome, 160ms                                            |
| 250    | _If unresolved_ → spinner on the tile. Never a dead gap                             |
| 900    | Tile confirmation fades, 200ms                                                      |

**Never fake a checkmark.** On failure: red scrim, **"Couldn't copy"**, and — the part that matters — the URL rendered as **selectable, pre-selected text in our chrome** so the user hits ⌘C and carries on. Hold 4000ms; this is an error requiring action.

**URL construction:** `new URL(a.getAttribute('href'), location.origin)` → take `origin + pathname` only. **Strip the query string** — the example URL is clean and a tracking param would be a visible defect.

---

## 7. Implementation detail

### 7.1 Manifest (MV3)

```json
{
  "manifest_version": 3,
  "name": "Tenor GIF Picker",
  "minimum_chrome_version": "116",
  "permissions": [
    "activeTab",
    "scripting",
    "declarativeNetRequestWithHostAccess",
    "clipboardWrite",
    "offscreen",
    "storage"
  ],
  "host_permissions": ["*://tenor.com/*", "*://*.tenor.com/*"],
  "background": { "service_worker": "sw.js", "type": "module" },
  "action": { "default_title": "Open GIF picker" },
  "commands": {
    "toggle-picker": {
      "suggested_key": { "default": "Alt+Shift+G" },
      "description": "Toggle the Tenor GIF picker"
    }
  },
  "content_scripts": [
    {
      "matches": ["*://tenor.com/*", "*://*.tenor.com/*"],
      "js": ["tenor-frame.js"],
      "css": ["tenor-frame.css"],
      "run_at": "document_start",
      "all_frames": true
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["picker.html", "picker.js", "picker.css"],
      "matches": ["<all_urls>"],
      "use_dynamic_url": true
    }
  ]
}
```

Notes: `action` has **no `default_popup`** — omitting it is what makes `chrome.action.onClicked` fire, which is what grants `activeTab`. `tenor-frame.css` is declared in the manifest (not `insertCSS`d later) so tenor's chrome is hidden **in the same paint as first render**. `web_accessible_resources.matches` is _not_ a host permission and generates no install warning.

### 7.2 The DNR rule

```js
// Session rules only — `tabIds` is not supported on static or dynamic rules,
// and session rules die at browser restart (fail-safe if we crash mid-open).
{
  id: XFO_RULE_BASE + tabId,
  priority: 1,
  action: { type: "modifyHeaders",
            responseHeaders: [{ header: "x-frame-options", operation: "remove" }] },
  condition: { requestDomains: ["tenor.com"],
               resourceTypes: ["sub_frame"],
               tabIds: [tabId] }
}
```

⚠️ **Do not key this on `initiatorDomains`** — that's what a web search returns for this problem and it matches **zero requests**, silently, forever.

Deliberately _not_ in the rule: no CSP removal (unnecessary — no `frame-ancestors`), no `Set-Cookie`/`SameSite` rewriting (a real security downgrade; unnecessary since tenor works cookieless).

**Ordering is load-bearing:** `await armFraming(tabId)` must resolve **before** the tenor iframe's `src` is set, or the navigation races the rule and you get a blocked frame with no obvious cause. So `picker.html` ships the tenor `<iframe>` with **no `src`**, opens a port, and sets `src` only after the SW acks.

**Teardown:** `picker.html` holds a long-lived `chrome.runtime.connect()` port. `onDisconnect` fires on _every_ teardown path — user closes, host navigates, tab closes, tab crashes — so one event covers all of them. Belt: `chrome.tabs.onRemoved`. Braces: reconcile `getSessionRules()` against live tabs on SW startup.

**Residual security hole, stated honestly:** while the picker is open in tab _N_, the host page in that tab could itself frame tenor.com XFO-free. The attacker must already be the page you're looking at and be probing for this extension, and the payoff is clickjacking a site whose cookies won't be sent anyway. Judged acceptable — and strictly narrower than every published "framebuster disabler," which strip XFO globally and permanently.

### 7.3 Click interception

> 🚨 **Self-arming guard — do this FIRST, before anything else in the frame script.**
>
> `tenor-frame.js` matches `*://tenor.com/*`, so it **also runs when the user browses tenor.com normally**. Without a guard, installing this extension silently breaks the real tenor.com: every GIF click there would copy instead of navigate. That is a serious, user-visible regression on a site the user did not ask us to modify.
>
> ```js
> const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
> const isPickerFrame = window.top !== window.self && location.ancestorOrigins?.[0] === EXT_ORIGIN;
> if (!isPickerFrame) return; // real tenor.com browsing: hands off, entirely
> ```
>
> `ancestorOrigins` is readable cross-origin and gives the immediate parent at index 0. Compare against `chrome.runtime.getURL("")` rather than a hardcoded ID so it follows `use_dynamic_url` rotation. **Belt:** also require a handshake message from the SW naming this `frameId`. **Braces:** the script is inert anyway unless a picker session is registered for the tab.

Single delegated capture-phase listener on `document`. **Delegation is mandatory, not stylistic:** in-frame search is client-side routed, so the entire results grid is destroyed and recreated on every query. Per-anchor listeners would work exactly once — on the initially SSR'd results — then silently stop.

```js
function resultUrlFrom(event) {
  for (const node of event.composedPath()) {
    if (node?.tagName !== 'A' || !node.href) continue;
    const u = new URL(node.href, location.href);
    if (u.protocol !== 'https:') return null;
    if (!/(^|\.)tenor\.com$/.test(u.hostname)) return null;
    if (!u.pathname.startsWith('/view/')) return null; // structural, not href*="/view/"
    return u.origin + u.pathname; // strip tracking params
  }
  return null;
}
document.addEventListener('click', intercept, true);
document.addEventListener('auxclick', intercept, true); // middle-click
document.addEventListener(
  'dragstart',
  (e) => {
    if (resultUrlFrom(e)) e.preventDefault();
  },
  true,
);
```

`click` not `pointerdown`: `click` is what actually triggers navigation, fires for keyboard activation free, and carries user activation. Copying on `pointerdown` would fire on press — press, drag off, release would still copy. Wrong.

`u.pathname.startsWith("/view/")` **not** `href*="/view/"` — the latter false-positives on any URL carrying `/view/` in a query string.

A second narrow guard keeps the frame pinned to tenor: off-origin link clicks are cancelled and relayed to the SW → `chrome.tabs.create`, so the picker can never become a random website, but the user is never trapped.

### 7.4 Clipboard chain

| #     | Where                                               | Mechanism                                                                                                                                                              | Success signal                                 |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **1** | tenor frame, **synchronously in the click handler** | `navigator.clipboard.writeText()` — side-effect-free                                                                                                                   | promise resolves                               |
| 2     | tenor frame, same handler                           | `execCommand('copy')` + throwaway `<textarea>` + capture-phase `copy` listener that `setData`s our payload (**removed in `finally` — never `{once:true}`, see below**) | **return value `true`** and our listener fired |
| 3     | offscreen document via SW                           | `execCommand('copy')` (**not** `navigator.clipboard`)                                                                                                                  | boolean relayed                                |
| 4     | `picker.html` UI                                    | URL in a focused, pre-selected field + "Copy" button                                                                                                                   | user-visible                                   |

> 🐛 **Bug class that would defeat the entire chain — `execCommand('copy')` reports failure by returning `false`. It does not throw.**
>
> ```js
> // ✗ silently copies nothing: a false return is treated as success
> try {
>   await navigator.clipboard.writeText(url);
> } catch {
>   document.execCommand('copy');
> }
>
> // ✓ test the return value
> let ok = false;
> try {
>   await navigator.clipboard.writeText(url);
>   ok = true;
> } catch {
>   ok = false;
> }
> if (!ok) {
>   try {
>     ok = document.execCommand('copy');
>   } catch {
>     ok = false;
>   }
> }
> if (!ok) showManualCopyFallback(url);
> ```
>
> A `try/catch` chain around tier 2 is not a fallback — it is a silent data-loss bug wearing one.

> 🚨 **Never register the `copy` listener with `{once: true}`. It ships a clipboard hijack.**
>
> `{once: true}` self-removes only when the event **fires**. On the exact path we care about — `CanWriteClipboard` false → `EnabledCopy` false → `execCommand` returns `false` **without ever dispatching `copy`** — the listener is never consumed and **stays registered on `document` forever**. The next time the user selects text in tenor's search box and hits ⌘C, they get our GIF URL instead of their own selection.
>
> It only arms _after_ a prior copy failure, so **no happy-path test will ever surface it.**
>
> Fix: explicit `removeEventListener` in a `finally`. Safe because `execCommand` dispatches synchronously — both events have fired by the time `finally` runs. **Write the reason in an inline comment**, because `{once:true}` is the obvious idiom here and someone will reach for it.

**On focus, precisely** — two questions that are easy to merge and must not be:

- _Does `execCommand` **require** focus?_ **No.** All nine selection gates in `clipboard_commands.cc` are guarded by `source == kMenuOrKeyBinding`, and `document.execCommand()` runs as `kDOM`. Source documents the intent: _"Since copy is a read-only operation it succeeds anytime a selection is visible… the selection does not need to be focused."_
- _Does our **recipe** move focus?_ **Yes — unavoidably.** `TextControlElement::select()` calls `Focus(...)` as its second statement (`text_control_element.cc:346-353`), and we need `.select()` because `Editor::CanCopy()` requires `visible_selection.IsRange()` (`editor.cc:268`).

**So tier 2 does steal the caret from tenor's search box.** That is a real side effect, paid on every fallback — and it is part of why D2 orders the side-effect-free `writeText` first. Restore the previous selection _and_ focus afterwards; be a good guest.

The capture-phase `copy` listener also stops any tenor page handler rewriting what lands on the clipboard.

> ⚠️ **Trap for whoever implements this: the `beforecopy` shortcut wipes the user's clipboard.**
>
> Reading `EnabledCopy` closely reveals that cancelling `beforecopy` short-circuits it `true` with no selection — which looks like an elegant way to delete the `<textarea>` entirely. The short-circuit is real (independently verified by two agents). **But the naive form destroys the clipboard.** `DispatchCopyOrCutEvent` passes `kWritable` for _both_ `beforecopy` and `copy` (`clipboard_commands.cc:238-260`), so cancelling `beforecopy` bare commits an **empty** `DataObject` immediately — `WriteDataObject()` then `CommitWrite()` — and only the later `copy` event restores it. Any failure between the two leaves the clipboard **destroyed rather than untouched**, which inverts the failure mode of the very tier that exists to handle failure.
>
> If used, `setData` the same payload on **both** events so the two commits are idempotent with no empty window. Its cost: `CommitWrite()` bumps the clipboard sequence number regardless of content, so **two commits per copy** — a clipboard-history manager (Raycast, Maccy, Alfred) may log the URL twice per click.
>
> The real choice is _duplicate clipboard-history entries_ vs _focus theft_. Neither is free. **Phase 0 decides**, and whichever wins, we are accepting the other's cost knowingly.

Tier 4 is **always reachable**: the picker always displays the last copied URL in a small selectable field, so even a lying `true` leaves the user one ⌘C from success.

### 7.5 CSS surgery — allow-list

```css
/* TIER A · structural. Two selectors remove six of BaseApp's seven children. */
.BaseApp > *:not(.SearchPage) {
  display: none !important;
}
.SearchPage > *:not(.gallery-container) {
  display: none !important;
}

/* TIER B · reclaim vertical space (400×540 is tight) */
.gallery-container > h1 {
  display: none !important;
}
.UniversalSearchFormatToggle {
  display: none !important;
}

/* TIER C · per-tile: sign-in-gated affordances that would be dead clicks */
.UniversalGifListItem .actions,
.UniversalGifListItem .FavButton {
  display: none !important;
}

/* TIER D · the important one — kills promoted tiles structurally, by name-independent invariant */
.UniversalGifListItem:not(:has(a[href^='/view/'])) {
  display: none !important;
}
```

Tier D matters most. The "Upload to Tenor" ad reuses `.UniversalGifListItem` and differs only by carrying `.Gif.Card`; matching `.Card` would break the day they run a different campaign. Matching on _"links to `/view/`"_ — the invariant that actually defines a result — removes the current ad **and whatever they inject next**, with no code change. `:has()` is Chrome 105+, unconditionally safe here. The same invariant guards the click path, so even with the CSS entirely broken, clicking an ad tile cannot produce a bogus clipboard write.

**Note both `Banner`s ship with class `hidden`** and are un-hidden by JS from cookie/storage state. In a partitioned third-party frame the page looks like a first-ever visitor, so **expect both banners to appear even though they never do in normal browsing** — and, because storage is partitioned _per top-level site_, dismissing them on github.com would not dismiss them on twitter.com. The user would re-dismiss **once per website**. Hide proactively; never depend on dismissal state.

**The 142 `/search/` chips: keep them, routed through our search state.** Discord's picker has category chips; tenor hands us equivalents free. Naively leaving them creates a desync (chip navigates to `/search/kitten-gifs` while our input still says "cat"). Fix costs nothing since we already have the interceptor: intercept `a[href^="/search/"]` the same way, parse the query, relay it up, let the parent update our input **and** drive the navigation. One interceptor, two verbs, no desync.

### 7.6 Health checks — never ship a blank box

The allow-list's failure mode is catastrophic _and silent_: if `.SearchPage` is renamed, Tier A hides **everything** and the user gets an empty box with no error. The in-frame script runs four assertions after layout settles:

| #      | Assertion                                     | Failure means                     | Remedy                                                      |
| ------ | --------------------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| H1     | `a[href^="/view/"]` count > 0                 | No results exist                  | Not a surgery failure — this is the **empty-results** state |
| **H2** | ≥1 such anchor has a **non-zero client rect** | Results exist but **we hid them** | **Rip out our own stylesheet**, report `degraded`           |
| H3     | `.BaseApp > *` count within expected band (7) | Structure shifted                 | Report `structure-drift`, keep CSS, flag                    |
| H4     | Rendered column count === 2                   | Their JS thresholds changed       | Cosmetic; report only                                       |

**H2 is the critical one, and it is deliberately not the same check as H1** — distinguishing "no results" from "results we accidentally hid" is the entire point, and a naive single check conflates them. Measuring a _client rect_ rather than counting nodes is what separates them.

**Governing rule: an ugly picker showing real GIFs beats a beautiful empty one.** This converts our worst failure mode from "broken product" to "cosmetic regression."

No telemetry: surface `degraded` as a small dismissible note in our chrome, and write the result + observed release string (`?release=r260623-1-master-d14a`) to `chrome.storage.local` so a bug report carries its own diagnosis.

### 7.7 Loading / empty / error / blocked

| State       | Detection                               | UI                                                                                                                          |
| ----------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Loading     | `{type:'ready'}` not yet received       | 2-column **shimmer skeleton** matching tenor's 10px spacing and 5px radius — the picker should look like itself immediately |
| Slow        | >3000ms                                 | Skeleton + "Still loading…"; >8000ms offer "Open Tenor in a new tab"                                                        |
| Empty       | in-frame count of `/view/` anchors is 0 | **Our own** empty state — their copy isn't sized for 400px                                                                  |
| Offline     | `navigator.onLine === false`            | Offline panel + Retry; auto-retry on `online`                                                                               |
| **Blocked** | **`ready` never arrives within 3000ms** | See below                                                                                                                   |

**Detecting a blocked frame is subtle, and the obvious approach cannot work.** From the parent, a cross-origin frame is **opaque whether it succeeded or failed** — `contentDocument` is `null` and reading `contentWindow.location.href` throws, in both cases identically. So the iframe's `load` event carries _no success information_, and there is no property of the frame the parent can inspect to tell "tenor rendered" from "Chrome blocked it". **Do not build detection on `load`.**

The only reliable detector is the **absence of our own in-frame script's handshake** — a positive signal built from something we control. The in-frame script posts hello at `document_idle`; the picker starts a timer when it sets `src`; no hello within ~3s → error state.

**One handshake covers the entire blank-picker class:** XFO returning after a Chrome change (the §5.1 watch item), the DNR rule failing to register, tenor being down or renamed, the network being offline, or tenor moving off the `/search/` URL shape. All of those otherwise present identically — an empty rectangle with no error. This is why the handshake is mandatory, not polish.

Recovery UI, never a white box: **"Can't load Tenor here"** + likely cause + **primary action "Open Tenor in a new tab"** (which always works, on every site, forever) + Retry.

---

## 8. Phases

### Phase 0 — de-risking spike ⚠️ RUN THIS FIRST

Everything above is source-verified but **nothing has been executed**. One throwaway unpacked extension (~4 files, ~15 min, built _outside_ the project directory) closes every remaining unknown at once. It must be a real extension — nothing else exercises DNR, and DNR is the load-bearing piece.

| Test                                                                 | Answers                                                                                                                                                                             |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `example.com` (no CSP)                                               | Does DNR strip XFO at all? Does the frame render? Does the copy work?                                                                                                               |
| **`github.com`** (strict CSP)                                        | Does the CSP bypass hold in a _shipping_ build, not just `main`?                                                                                                                    |
| Visit tenor.com top-level first, _then_ open the picker              | Does a warm HTTP cache defeat the strip?                                                                                                                                            |
| Window at ~400px on `/search/cat-gifs`                               | **Confirm 2 masonry columns** — the entire geometry spec rests on the 576px threshold                                                                                               |
| Probe `sandbox` attribute                                            | Does `allow-same-origin allow-scripts` break tenor's SPA?                                                                                                                           |
| **Scroll the frame to the bottom**                                   | **Do results arrive past #49?** (§5.5) The one check that catches silent pagination truncation — every other check passes while it's broken                                         |
| Right-click a result tile                                            | Does "Copy link address" yield the absolute `https://tenor.com/view/…`? It is now our **only** escape hatch (D7), so confirm it survives                                            |
| Time open → first painted grid                                       | `activeTab` traded a permissions problem for a **latency** one: open is now inject → shadow root → iframe → arm DNR → ack → set `src`. Measure it before committing to the sequence |
| **Browse `tenor.com` normally** (not via the picker) and click a GIF | **It must navigate, not copy.** Verifies the §7.3 self-arming guard. Getting this wrong silently breaks a site the user didn't ask us to touch                                      |
| Copy once, then check a clipboard-history app (Raycast/Maccy/Alfred) | Does one click produce **one** history entry or two? Decides the §7.4 `beforecopy`-vs-`textarea` trade                                                                              |

**Pass criteria:** grid renders in all three; clicking a GIF copies `https://tenor.com/view/…` and does **not** navigate; clicking a tag chip **does** navigate; typing a query and pressing Enter searches.

**And take a screenshot** — that's the answer to the day-one look question in §3, and it costs nothing extra.

**If test 1 fails, stop and reconsider before writing anything real.**

### Phase 1 — Skeleton

Manifest, SW, DNR arm/disarm with port lifecycle, `activeTab` injection, empty picker frame. **Exit:** toolbar click opens an empty extension-origin panel bottom-right on a strict-CSP site; DNR rule arms and disarms cleanly.

### Phase 2 — The frame

tenor iframe with correct `src` ordering, `allow="clipboard-write"`, handshake, CSS allow-list, health checks H1–H4. **Exit:** search results render chrome-less at 2 columns; banners and promoted tile never appear; H2 self-heal verified by deliberately breaking a selector.

### Phase 3 — The stipulation

Click interception, clipboard chain tiers 1–4, on-tile confirmation, failure UI. **Exit:** every assertion in §9 passes on `example.com`.

### Phase 4 — Chrome & states

Our search bar, skeleton/empty/offline/blocked states, Esc relay, `commands` shortcut, theming, toast.

### Phase 5 — Hardening

Full E2E matrix, tenor-markup canary in CI, golden screenshots, lint/typecheck clean.

_Resizing is v1.1._

---

## 9. Verification

**Automated** (the pure parts, `vitest`): URL construction and normalisation; query encoding; message-type exhaustiveness via TS at compile time; manifest + DNR schema validation.

**The tenor-markup canary — highest-value automated test in the project.** Check in a captured search page as a fixture; have CI periodically re-fetch the live page and assert every structural invariant we depend on: `.BaseApp` still has 7 children and `.SearchPage` among them; `.gallery-container` exists; `/view/` anchor count in band; every non-`/view/` tile is caught by Tier D; the masonry constants `576`/`1100` still appear in their bundle; **`x-frame-options` is still the only framing block and no `frame-ancestors` has appeared.** This converts "tenor redeployed and our picker silently looks wrong" into a CI failure with a named cause, days before it reaches a user.

**Manual E2E.** Note the extension must be loaded via `chrome://extensions`, which browser automation generally cannot drive — **that handoff is a human step**, after which automation can take over.

| #   | Site                                                                                                              | Assert                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `example.com`                                                                                                     | Full happy path; exact 20/20 offsets, 400×540, 2 columns, hairline visible, no 4px seam                                                                           |
| 2   | **`github.com`**                                                                                                  | Frame loads **or** blocked-recovery UI within 3s. **Never a white box.** Most important test here                                                                 |
| 3   | `developer.mozilla.org`                                                                                           | Second strict-CSP point                                                                                                                                           |
| 4   | Site with its own bottom-right chat bubble                                                                        | We're above it; we don't permanently cover it after close                                                                                                         |
| 5   | Notion / Gmail                                                                                                    | Heavy SPA, `transform` ancestors, Trusted Types. Survives soft navigation                                                                                         |
| 6   | **`web.whatsapp.com`**                                                                                            | **COEP `require-corp` — known unmitigable.** Assert we degrade to a clear message, not a broken shell                                                             |
| 7   | Dark + light themed sites                                                                                         | No white-rectangle-in-dark-frame                                                                                                                                  |
| 8   | `chrome://extensions`, Web Store, PDF                                                                             | Absent **silently**; zero console errors; toolbar click gives a sensible message, not a dead button                                                               |
| 9   | 50% / 100% / 175% zoom                                                                                            | Clamps hold                                                                                                                                                       |
| 10  | Site A → site B → back to A                                                                                       | **Banners never appear on any of them** (the partitioned-storage defect; only observable this way)                                                                |
| 11  | Scroll to ~`data-index` 16                                                                                        | Promoted tile absent. Then disable our CSS and click it → **clipboard unchanged**                                                                                 |
| 12  | **Scroll past result #49** (§5.5)                                                                                 | More results load. **Assert the count keeps climbing** — silent truncation at 49 passes every other check in this document                                        |
| 13  | **Clipboard-hijack regression** (§7.4): force a copy failure, then select text in tenor's search box and press ⌘C | **You get your own selection, not the GIF URL.** Only reachable after a prior failure, so it will never appear on a happy path — it needs its own deliberate test |
| 14  | Browse `tenor.com` in a normal tab, click a GIF                                                                   | **Navigates as usual.** The §7.3 self-arming guard; regression here breaks a site we were never asked to modify                                                   |

**Every run, every site:**

- Clicking a tile **never navigates** — verify with the back button afterwards; history must be unchanged
- Clipboard is exactly `https://tenor.com/view/…`, **no query string**
- Confirmation appears **on the clicked tile**
- **Esc closes the picker _after_ clicking inside the grid** — the §6 trap, and the assertion most likely to fail first. Test in that exact order
- Shortcut toggles while focus is inside the iframe
- No FOUC — tenor's nav/banners never visible, not even one frame. Verify by recording and stepping, not by eye
- Host page console clean

**Pixel guard:** golden screenshots at three zoom levels, diffed. Eyeballing will not hold over time.

---

## 10. Residual risks

| Risk                                                                                                                                                | Severity                                      | Mitigation                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nothing has been executed** — all conclusions are Chromium `main` source, not a shipping binary                                                   | **High until Phase 0**                        | Phase 0 exists precisely for this                                                                                                                                |
| **COEP `require-corp` on host page** blocks the extension frame. `web.whatsapp.com` ships it. No scheme bypass exists (crbug 40846826)              | **Unmitigable**                               | Detect and degrade honestly. _Rejected:_ DNR-stripping COEP — it's load-bearing for Spectre isolation and would need host-page permissions we deliberately avoid |
| **Chrome deletes the ParsedHeaders reparse** (`crbug.com/40765899`, §5.1). Picker goes blank silently on an auto-update, with no change on our side | Latent, unpredictable timing                  | **No test on our machine can catch this** — the regression ships with the user's browser. The §7.7 runtime handshake is the only real mitigation. Watch that bug |
| **Pagination silently truncates at 49 results** (§5.5). Load-more is a live v2 API call from a partitioned third-party frame                        | Unverified; **health checks do not catch it** | Phase 0 scroll test + E2E row 12. If it fails, options are: accept 49 per query, drive `src` to the next page, or move load-more into our chrome                 |
| Tenor adds `frame-ancestors`                                                                                                                        | Fatal if it happens                           | Nothing to do but detect. **The single biggest external dependency in the design** — the CI canary watches for it                                                |
| Tenor redeploy breaks CSS surgery                                                                                                                   | Moderate, recurring                           | Allow-list + H1–H4 self-heal + CI canary. Worst case is _ugly_, never _blank_                                                                                    |
| Tenor moves results to client-side rendering                                                                                                        | Low                                           | The **iframe is immune** (it runs their JS). Worth noting this would kill a scraping approach outright                                                           |
| `execCommand` eventually removed                                                                                                                    | Low, slow-moving                              | `writeText` tier already implemented alongside                                                                                                                   |
| `use_dynamic_url: true` interactions with `getURL()`/`ancestorOrigins`                                                                              | Low                                           | Phase 0; fall back to `false` — cost is fingerprintability, not correctness                                                                                      |
| ToS / Web Store                                                                                                                                     | Low for personal use                          | No clause found prohibiting framing; multiple XFO-stripping extensions ship in the store today. Only matters **if you publish**                                  |

---

## Appendix — fallback ladder

| Tier  | What                                                                                                                             | When                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Same picker, mounted in the **toolbar popup** (extension-origin → immune to host CSP _and_ COEP)                                 | Automatic fallback on sites where framing fails. Nearly free if the UI is built mount-agnostic from day one — **which is the main architectural reason to do so** |
| **1** | Cross-origin tenor iframe, XFO stripped **(this plan)**                                                                          | Default                                                                                                                                                           |
| 2     | Iframe variants — frame `/search/{q}-gifs` directly (never route through the homepage); no `sandbox` without `allow-same-origin` | Risk reduction                                                                                                                                                    |
| 3     | Extension-side `fetch` + `DOMParser` of tenor's SSR HTML, our own grid                                                           | **Designed, not built.** Put the grid behind a `search(q) → Result[]` interface from day one so this is a data-source swap, not a rewrite                         |
| 4     | Different provider (Giphy, Klipy)                                                                                                | **Not a fallback — a different product.** No other provider can emit a `tenor.com/view/…` link. Named and dismissed                                               |
| 5     | Toolbar opens tenor.com in a **normal tab** with the same click-to-copy content script                                           | ~30 lines, essentially unbreakable, and **the in-frame interception code is identical**. Not the product, but it's the thing that still works in 2028             |

**On Tier 3, two honest notes that invert the usual intuition:**

1. **Scraping is _more_ ToS-exposed than framing, not less.** The iframe renders tenor's real page in the user's own browser — tenor still gets the pageview and its ad impressions (including the promoted tile we hide but still load). Scraping takes the content and discards the page. With the sanctioned API path closed in June, every remaining route is unsanctioned, so the question is which is more defensible — **and framing is the friendlier one.** This is a real argument for the original instinct.
2. **Tier 3 fails _harder_.** Broken iframe CSS self-heals to an ugly-but-working picker. A broken parse yields **zero results**. And Tier 3 depends on tenor server-rendering results into the initial HTML — an ordinary thing for a React SPA to stop doing — where the iframe would be unaffected.

**Team's honest split on Tier 3:** on _daily feel_ — pixel control, works on 100% of sites, real dark mode, keyboard navigation that actually works — our own grid wins decisively, and a pixel-perfectionist experiences daily use every day and failure modes rarely. On _durability and defensibility_, the iframe wins. Recommendation is to build the iframe (it's the spec, and the evidence came back better than expected) while keeping the data source cleanly swappable, so real usage settles the question instead of three agents speculating.

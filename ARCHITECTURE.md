# Architecture

PR Files Tabs adds tabs to GitHub's pull request **Files changed** page, both the new one
(`/owner/repo/pull/N/changes`) and the classic one (`/owner/repo/pull/N/files`). Hiding
files is simple; making GitHub *not load* the hidden files takes several hacks against
GitHub's front-end internals. This document explains both, and what to check when GitHub
changes.

## Files

| File | World | Runs at | Job |
|---|---|---|---|
| `shared.js` | all | - | Config defaults, pattern matching, `prKey`, `initialKey` (which tab a PR opens on) |
| `content.js` | isolated | `document_idle` | Tab bar, counts, hiding files with CSS, publishing state for the page scripts |
| `content.css` | isolated | - | Tab bar styles, `[data-ghpt-hidden]` |
| `page.js` | MAIN | `document_start` | Load diffs on demand: virtualized list + swapping GitHub's file list; classic chunk budget |
| `prefetch.js` | MAIN | `document_start` | Parallel diff loading |
| `options.*` | extension page | - | Settings |

"MAIN" scripts run in GitHub's own JavaScript context so they can wrap `window.fetch`, rewrite
GitHub's page data and reach its React state. Isolated scripts can't, but they can read
`chrome.storage`.

### How the worlds talk

- **Config:** MAIN scripts can't read `chrome.storage`, and they need the config before it
  could answer anyway. `content.js` copies the config to `localStorage['ghpt:config']` on
  load and on every change; `page.js` and `prefetch.js` read it synchronously. On the very
  first visit there is no copy yet, so that load behaves like GitHub's default.
- **Open tab:** `content.js` writes the active tab key to `<html data-ghpt-active="...">`
  (`all`, or the tab's index). `page.js` watches that attribute.
- **Saved choice:** the tab picked on a PR is in `sessionStorage['ghpt:owner/repo#N']`,
  which both worlds can read. `GHPT.initialKey()` combines it with `defaultTab`.

`shared.js` is listed in one MAIN entry and one isolated entry. Chrome only injected it into
one context when two `document_start` entries in different worlds both listed it, so there is
a single `document_start` entry.

## How GitHub loads diffs

Found by reading GitHub's bundles (the chunk that defines `startQueue`,
`progressiveDiffsActions` and `diffEntriesActions`).

- **File list.** The page HTML embeds `<script type="application/json"
  data-target="react-app.embeddedData">` whose `payload.pullRequestsChangesRoute` holds
  `diffSummaries` (every file: `path`, `pathDigest`, line counts, `markedAsViewed`, ...),
  `diffContents` (the first file's diff inline) and `virtualizeDiffEntries`. In-app navigation
  fetches the same JSON from `/pull/N/changes` with header `X-GitHub-App-Type: dataRouter`.
- **Diff contents.** `GET /owner/repo/pull/N/page_data/diff_entries?paths=...&ctx=...&w=0&range=<sha>`.
  `paths` is `%2C`-separated, each path URI-encoded twice. The response is a JSON array, one
  entry per path, each with `path`, `pathDigest` and `diffLines`.
- **The loader** keeps a priority queue plus two sets, *loaded* and *in flight*. It sends one
  request at a time (batch size 4) and waits for it before the next. Files that scroll into
  view or get selected jump the queue (`loadPriority` / `loadManyPriority`).
  - Normal list: `startQueue({ autoLoadAllDiffs: true })`, so after the priority files it walks
    the whole list in order, about 42 sequential requests for 167 files.
  - Virtualized list (`virtualizeDiffEntries: true`, which GitHub sets for very large PRs):
    `startQueue()` without auto-load, plus `loadManyPriority(rows near the viewport)`. Only
    what's near the screen is fetched.
  - **Gotcha:** after a response, only paths *present in it* are marked loaded. A requested
    path missing from the response stays "in flight" forever and is never asked for again.
    Never answer GitHub with a partial array.
- **The store** is a zustand store provided through React context. It holds `diffSummaries`
  as an object keyed by path, and actions including `diffSummariesActions.setDiffSummaries`.
  The diff list and file tree render from it. The loader's own file order (`entriesMap` /
  `entriesOrder`) is built once from the initial summaries and isn't affected by
  `setDiffSummaries`.

## Hiding files (content.js)

Each file in the active tab is classified with `GHPT.classify()`. Files outside it are hidden
two ways:

1. A `<style id="ghpt-filter">` with `div:has(> #diff-<digest>)` (classic:
   `copilot-diff-entry:has(> ...)`) and tree-item rules, built from the embedded file list
   (classic: the file tree), so files are hidden the moment GitHub renders them.
2. `data-ghpt-hidden` on each rendered diff's outermost wrapper (`slotOf()`).

`slotOf()` climbs while the parent has only one child, but stops at a virtualized row
(`[data-index]`), and every pass clears marks it doesn't set again. Without both rules a
wrapper that briefly held one hidden diff stayed hidden after GitHub put more rows into it,
which blanked the whole list.

## Hack 1: load diffs on demand (page.js)

**Goal:** when a PR opens on a tab other than All, don't fetch the other tabs' diffs.

1. **Force the virtualized list.** A `MutationObserver` on `document` (the root element
   doesn't exist yet at `document_start`) catches the embedded data script, sets
   `virtualizeDiffEntries = true` and writes the JSON back before GitHub's deferred bundles
   read it. The parser streams large JSON into the script's existing text node, which fires
   no `childList` record, so incomplete scripts are kept in a pending set and re-parsed on
   every later batch of DOM changes. A `fetch` wrapper does the same to the route JSON
   for in-app navigation.
2. **Give GitHub only the open tab's files.** In the virtualized list, hidden rows still take
   space and still fall inside the "near the viewport" window. A tab with 3 files at the end
   of the list showed a blank screen. So `page.js` finds GitHub's store by walking React
   fibers up from the diff list (`__reactFiber$...` -> `.return` until
   `memoizedProps.value.getState().diffSummariesActions` exists) and calls
   `setDiffSummaries()` with only the open tab's files. The list, tree and "viewed" counter
   then show just those, and the loader only fetches what renders.
3. **Switching tabs** changes `data-ghpt-active`; `page.js` swaps in the new tab's files, or
   the full list for All. No reload, no navigation. The loader still knows every file, so
   newly shown files load as they reach the screen.
4. **Keeping the full list honest.** `page.js` subscribes to the store. If GitHub replaces the
   summaries with the same set of files (e.g. one marked viewed), those versions are merged
   into the saved full list. If the set of files changes (e.g. new commits), that becomes the
   new full list and the tab is applied again.

If the store isn't found or doesn't look as expected, nothing is swapped and CSS hiding
still works. If PRs open on All, nothing here runs.

Trade-offs: Find on Page only sees diffs near the screen (GitHub shows its own banner about
this), and GitHub's tree and viewed counter show the open tab's files rather than the PR's.

## Hack 2: parallel diff loading (prefetch.js)

**Goal:** when GitHub does fetch everything (a PR opened on All), don't do it one request
at a time.

- `prefetch.js` loads after `page.js` in the same entry, so its `fetch` wrapper sits
  outside `page.js`'s.
- On GitHub's first `diff_entries` request it reads the file list (embedded data, or the
  route JSON after in-app navigation) and fetches every not-yet-loaded file itself, 4 per
  request, 5 requests in flight, in file order, reusing GitHub's query (`range`, `w`) and
  headers.
- Each of GitHub's own requests is answered from those results as soon as all its paths are
  in. Paths GitHub asks for out of order (a file scrolled into view) are fetched immediately.
- If any of a request's paths failed, GitHub's original request goes through unchanged
  (never a partial answer, see the gotcha above). Requests with extra context lines
  (`ctx` not all `:`) are passed through.
- It stands down when the file list is virtualized, since fetching everything would undo
  hack 1.

File order beats "open tab first": GitHub only shows a file once its own sequential queue
reaches it, so fetching later files first just makes the queue wait.

## The classic page (`/pull/N/files`)

GitHub still serves the older, server-rendered Files changed page (for example when logged
out, or with the new page's preview turned off). It works differently:

- **File list:** no embedded JSON, but the sidebar tree lists every file at load as
  `li#file-tree-item-diff-<digest>[data-tree-entry-type="file"]`, with the path in
  `data-hydro-click-payload` (`payload.data.path`). `content.js` reads counts and paths from
  there. Folders are `[data-tree-entry-type="directory"]` without `aria-expanded`.
- **Diffs:** `div.js-diff-progressive-container > copilot-diff-entry > div#diff-<digest>.file`.
  The page HTML holds the first 8 files; the rest come as HTML chunks from
  `/owner/repo/diffs?start_entry=N&bytes=B&lines=L&...` (an `include-fragment`), where B and L
  are the bytes and lines already rendered. A 167-file PR takes 2 chunks (~3.7 MB for the
  first).
- **Per-file loading:** large and deleted files get a "Load diff" placeholder:
  `.js-diff-load-container > include-fragment.js-diff-entry-loader[data-fragment-url]`, where the
  URL is `/owner/repo/diffs/<file index>?name=<head sha>&base_sha=...&sha1=...&sha2=...`. Its
  `.js-diff-load` button makes GitHub load it.

### Tab bar placement

New page: first child of the right-hand group in the sticky toolbar (left of the viewed counter
and Submit review). Classic page: last child of the sticky toolbar row
(`.pr-toolbar .diffbar .d-flex.flex-wrap`, the row with "Changes from all commits"), pushed
right by the bar's auto margin. That row wraps rather than overflows, so `fit()` collapses the
bar to a dropdown when it ends up on a second line. Without either toolbar the bar goes above
the first diff.

### Hack 3: classic on demand (page.js + content.js)

Same experiment and condition as hack 1 (PR opens on a tab other than All).

1. `page.js` rewrites the chunk request's `bytes` and `lines` to values over GitHub's page
   budget. The server then sends **every remaining file in one response as a placeholder**
   (~1.8 MB instead of ~3.7 MB + a second chunk, and no diffs to render).
2. Before handing the response to GitHub, `page.js` parses it in a `<template>` (inert: nothing
   runs or upgrades), tags every loader `data-ghpt-deferred`, and sets `src` on the first 6
   in the open tab so they start loading the moment GitHub inserts the chunk.
3. `content.js` watches the other tagged loaders with an `IntersectionObserver` (1500 px
   margin) and sets their `src` when they come near the screen. Hidden files never intersect,
   so they never load; switching tabs shows them and they load as you scroll.
4. Placeholders with a reason text (e.g. "This file was deleted.") are left for the user, as
   GitHub intends.

Loading goes through `src`, not GitHub's "Load diff" button: the button's handler also focuses
the loaded diff, which scrolled the page to every file that loaded and pulled the next ones
into range.

Trade-off: over budget, GitHub drops the "Large diffs are not rendered by default" reason, so
a genuinely large diff in the open tab loads when you scroll to it instead of waiting for a
click. The first 8 files are in the page HTML and always render.

## Approaches tried and dropped

- **CSS only** (the original). Hidden files were still fetched and rendered.
- **Trimming GitHub's requests** to the open tab's paths. Works for the first load, but the
  trimmed files stay "in flight" forever, so switching to All needed a page reload.
- **Rewriting the embedded file list to a subset**, then making GitHub reload it. Leaving
  and returning via the Commits tab keeps the old list in memory; only a round trip through
  Conversation resets it, which is visible and slow.
- **GitHub's own file filter.** It only hides; every diff is still fetched, it isn't in the
  URL, and it only matches text and extensions.
- **The extension's service worker or `declarativeNetRequest`.** They can't see or answer the
  page's fetches with a modified body; blocking a request shows GitHub an error.
- **Holding back requests for hidden files.** The loader waits on each request, so holding
  one blocks every file behind it.

## When GitHub changes

What to check, roughly in order of likelihood:

1. **Selectors:** `script[data-target="react-app.embeddedData"]`,
   `[data-testid="virtualized-diffs-list"]`, `[data-index]` rows, `#diff-<digest>` ids,
   `[role="tree"] li[role="treeitem"]`, the "Submit review" toolbar. Classic page:
   `li#file-tree-item-diff-*` and its `data-hydro-click-payload`, `copilot-diff-entry`,
   `include-fragment.js-diff-entry-loader`, `.js-diff-load`.
2. **Data shape:** `payload.pullRequestsChangesRoute.{diffSummaries, diffContents,
   virtualizeDiffEntries}`.
3. **Endpoints:** `page_data/diff_entries` and its `paths` encoding; on the classic page the
   `diffs?start_entry=` chunk budget and `diffs/<index>` per-file loads.
4. **Store:** the context provider whose value has
   `getState().diffSummariesActions.setDiffSummaries`, and `diffSummaries` keyed by path.
5. **Loader rules:** sequential batches, the in-flight gotcha, priority loading in both list
   modes.

Turning either experiment off in the options page restores GitHub's own loading for that
part.

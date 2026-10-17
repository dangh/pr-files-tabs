# Architecture

Sift for GitHub adds tabs to GitHub's pull request **Files changed** page, both the new one
(`/owner/repo/pull/N/changes`) and the classic one (`/owner/repo/pull/N/files`). Hiding
files is simple; making GitHub *not load* the hidden files takes several hacks against
GitHub's front-end internals. This document explains both, and what to check when GitHub
changes.

## Files

| File | World | Runs at | Job |
|---|---|---|---|
| `shared.js` | all | - | Config defaults, pattern matching, `prKey`, `initialKey` (which tab a PR opens on) |
| `content.js` | isolated | `document_idle` | Tab bar, counts, hiding files with CSS, publishing state for the page scripts |
| `content.css` | isolated | - | Tab bar styles, `[data-sift-hidden]` |
| `page.js` | MAIN | `document_start` | Load the open tab first / the rest in the background: GitHub's file list and loader; the virtualized list when only the tab loads |
| `prefetch.js` | MAIN | `document_start` | Parallel diff loading when GitHub drives loading |
| `options.*` | extension page | - | Settings: native controls styled after Cloudflare's Kumo design system |
| `background.js` | service worker | - | Toolbar icon for light or dark mode; the icon opens the options page |
| `offscreen.*` | offscreen page | - | Watches `prefers-color-scheme` for `background.js`, which can't |

"MAIN" scripts run in GitHub's own JavaScript context so they can wrap `window.fetch`, rewrite
GitHub's page data and reach its React state. Isolated scripts can't, but they can read
`chrome.storage`.

### How the worlds talk

- **Config:** MAIN scripts can't read `chrome.storage`, and they need the config before it
  could answer anyway. `content.js` copies the config to `localStorage['sift:config']` on
  load and on every change; `page.js` and `prefetch.js` read it synchronously. On the very
  first visit there is no copy yet, so that load behaves like GitHub's default.
- **Open tab:** `content.js` writes the active tab key to `<html data-sift-active="...">`
  (`all`, or the tab's index). `page.js` watches that attribute.
- **Saved choice:** the tab picked on a PR is in `sessionStorage['sift:owner/repo#N']`,
  which both worlds can read. `SIFT.initialKey()` combines it with `defaultTab`.

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

Each file in the active tab is classified with `SIFT.classify()`. Files outside it are hidden
two ways:

1. A `<style id="sift-filter">` with `div:has(> #diff-<digest>)` (classic:
   `copilot-diff-entry:has(> ...)`) and tree-item rules, built from the full file list (see
   below), so files are hidden the moment GitHub renders them.
2. `data-sift-hidden` on each rendered diff's outermost wrapper (`slotOf()`).

**Which file list.** Counts and the CSS rules need every file in the PR, taken from the first of
these that's available:

1. On the classic page, the file tree.
2. `page.js`'s copy of the store's list, written to `<script type="application/json"
   id="sift-files">` with a `sift:files` event. `content.js` runs in another JS world and can't
   reach the store itself.
3. The embedded data, only if its PR number matches the URL.
4. The rendered diffs.

The embedded data can't come first: after in-app navigation to another PR (for example
through a PR stack's menu) it still describes the first PR. Rendered diffs come last because
once the store holds only one tab's files, that's all that renders, so counting them is wrong.
A list missing a rendered diff is treated as stale and skipped.

A PR that opens on the default tab (no tab picked on it yet) shows All when the full list
puts no files in that tab.

`slotOf()` climbs while the parent has only one child, but stops at a virtualized row
(`[data-index]`), and every pass clears marks it doesn't set again. Without both rules a
wrapper that briefly held one hidden diff stayed hidden after GitHub put more rows into it,
which blanked the whole list.

## Hack 1: load the open tab first, the rest in the background (page.js)

Two experiments, both on by default:

- **Load the open tab first** (`experiments.onDemandDiffs`): fetch every file of the open tab
  before anything else.
- **Load the rest in the background** (`experiments.backgroundLoad`): then fetch every other
  file, so switching tabs needs no requests.

The target order: page load, fetch the open tab's files (e.g. Source); then fetch every other
file in the background; switching tabs then makes no requests.

1. **Find GitHub's store.** `page.js` walks React fibers up from the diff list
   (`__reactFiber$...` -> `.return` until `memoizedProps.value.getState().diffSummariesActions`
   exists).
2. **Give GitHub only the open tab's files.** `setDiffSummaries()` with only the open tab's
   files; the list, tree and "viewed" counter then show just those. On All nothing is swapped
   (unless a tab was swapped in before).
3. **Ask the loader for the whole tab.** `progressiveDiffsActions.loadManyPriority(digests)`
   jumps GitHub's queue and fetches all the given files **in one request**. That request
   carries every path in its URL (encoded twice), so batches are capped at 100 files **and**
   about 6,000 characters of paths: on microsoft/vscode#151512 (deep paths) 92-100-file
   batches failed with 414 URI Too Long, and files from a failed request never load. Batches
   are sent one at a time (the loader serves these calls last-in
   first-out, so queueing several would scramble the order); each waits until the store marks
   its files loaded (`entriesMap[digest].isLoaded`), or 20 s, since a failed request leaves
   files "in flight" in GitHub's loader for good. Whatever is still missing is asked for again
   every second: the virtualized list keeps queueing its own small loads, which otherwise made
   the loader take a 96-file batch 4 files at a time. Files already loaded or in flight are
   skipped by the loader, so asking again is harmless.
4. **Then the rest** (background experiment): the same, for every file in `entriesMap` (the
   loader's own list, built once from the full file list).
5. **Switching tabs** changes `data-sift-active`; `page.js` swaps in the new tab's files and
   starts a new run, which stops the old one after its current batch. Files already loaded
   aren't requested again; the diff lines are cached with no expiry.
6. **Keeping the full list honest.** `page.js` subscribes to the store. If GitHub replaces the
   summaries with the same set of files (e.g. one marked viewed), those versions are merged
   into the saved full list. If the set of files changes (e.g. new commits), that becomes the
   new full list and the tab is applied again.

With the background load **off**, GitHub's normal list would still fetch every file one request
at a time, so `page.js` also switches GitHub to its **virtualized list** (normally used for huge
PRs), which only fetches what it's asked for and what is near the viewport. A `MutationObserver`
on `document` (the root element doesn't exist yet at `document_start`) catches the embedded data
script, sets `virtualizeDiffEntries = true` and writes the JSON back before GitHub's deferred
bundles read it. The parser streams large JSON into the script's existing text node, which fires
no `childList` record, so incomplete scripts are kept in a pending set and re-parsed on every
later batch of DOM changes. A `fetch` wrapper does the same to the route JSON for in-app
navigation. Trade-off in that mode: Find on Page only sees diffs near the screen (GitHub shows
its own banner about this). With the background load on, the normal list stays.

If the store isn't found or doesn't look as expected, nothing is swapped or requested and CSS
hiding still works. GitHub's tree and viewed counter show the open tab's files rather than the
PR's.

## Hack 2: parallel diff loading (page.js, prefetch.js)

**Goal:** GitHub's loader sends one diff request at a time; run several at once.

**With "Load the open tab first" on** (page.js drives loading): batches go up to 300 files, and
page.js's `fetch` wrapper splits every `diff_entries` request with more than 20 paths into
requests of up to 20 paths (and ~6,000 characters of paths), runs 6 at a time, and returns
their entries merged in the order asked for. GitHub's loader sees one request answered quickly.
Each path has a matching `ctx` entry (context lines, `:`-separated), split alongside it; if the
counts don't match the request goes through unchanged. A chunk that fails is retried once; if it
fails again the whole request fails, as GitHub's would. Because the long URL never reaches GitHub,
the 414 limit no longer applies to batch size.

**With "Load the open tab first" off** (GitHub drives loading, 4 files per request): `prefetch.js`
loads after `page.js` in the same entry, so its `fetch` wrapper sits outside `page.js`'s.
- On GitHub's first `diff_entries` request it reads the file list (embedded data, or the
  route JSON after in-app navigation) and fetches every not-yet-loaded file itself, 4 per
  request, 5 requests in flight, in file order, reusing GitHub's query (`range`, `w`) and
  headers.
- Each of GitHub's own requests is answered from those results as soon as all its paths are
  in. Paths GitHub asks for out of order (a file scrolled into view) are fetched immediately.
- If any of a request's paths failed, GitHub's original request goes through unchanged
  (never a partial answer, see the gotcha above). Requests with extra context lines
  (`ctx` not all `:`) are passed through.
- It stands down when the file list is virtualized.

File order beats "open tab first" here: GitHub only shows a file once its own sequential queue
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

### Loading on the classic page

The classic page loads as GitHub intends: its two HTML chunks render every file in a few
seconds (about 6.5 s cold for a 167-file PR), the extension hides other tabs with CSS, and
switching tabs makes no requests. Both loading experiments leave it alone (see "Approaches
tried and dropped" for the placeholder trick that was tried).

## Approaches tried and dropped

- **Classic page: diffs as placeholders, loaded per file.** Rewriting the chunk request's
  `bytes` and `lines` past GitHub's page budget makes the server send every remaining file as a
  "Load diff" placeholder in one response (~1.8 MB instead of ~3.7 MB), and each placeholder's
  `include-fragment` loads its diff from `/owner/repo/diffs/<file index>?name=<head sha>&...`
  when given a `src` (clicking "Load diff" instead also focuses the diff, scrolling the page).
  Loading the open tab that way took 11-13 s and ~80 requests for a 96-file tab, and the
  per-file HTML made a heavier page (~65,000 elements) than GitHub rendering all 167 files from
  its chunks (~37,000) in about 6.5 s.

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
   `.pr-toolbar .diffbar` row.
2. **Data shape:** `payload.pullRequestsChangesRoute.{diffSummaries, diffContents,
   virtualizeDiffEntries}`.
3. **Endpoints:** `page_data/diff_entries` and its `paths` encoding.
4. **Store:** the context provider whose value has
   `getState().diffSummariesActions.setDiffSummaries`, `diffSummaries` keyed by path,
   `progressiveDiffsActions.loadManyPriority` and `entriesMap[digest].isLoaded`.
5. **Loader rules:** sequential batches, `loadManyPriority` fetching its list in one request,
   the in-flight gotcha, priority loading in both list modes.

Turning the experiments off in the options page restores GitHub's own loading.

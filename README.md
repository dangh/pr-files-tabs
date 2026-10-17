<img src="icons/icon-128.png" width="96" height="96" alt="">

# PR Files Tabs

Chrome extension that adds configurable tabs (All / Source / Tests / Docs / Infra / Manifest / Artifacts by default)
to the GitHub pull request **Files changed** view, on both the new and the classic page.
Switching a tab filters both the diff list and the left file tree.

![The Tests tab on a pull request's Files changed page: the tab bar sits in GitHub's toolbar and the file tree shows only test files](store/screenshots/1-tests-tab.png)

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** and pick this folder, or drag in a zip from the
   [releases](../../releases).
3. Open a PR's Files changed page.

## Configure

Open the extension's options page to add, rename and reorder tabs, and to choose which
tab opens first on a PR. The tab you pick on a PR is remembered across refreshes.

One pattern per line; a tab shows a file when any pattern matches.

- `package*.json` matches the file name (`*` any characters, `?` one character).
- `services/*/lib/*` (contains `/`) matches the full path.
- `/test/i` is a regex tested against the full path.
- `!Manifest` excludes files that belong to the tab labelled Manifest; `!*.md` excludes
  files matching a pattern. A tab with only `!` lines starts from every file.
- Tabs can exclude each other (`!Infra` in Tests and `!Tests` in Infra): a file that matches
  both goes to the tab listed first, so reorder the tabs to choose.

## Experiments

All on by default; each can be turned off in the options page.

- **Load the open tab first.** When a PR opens on a tab other than All, a page script
  (`page.js`) hands GitHub's diff store just that tab's files and asks GitHub's own loader for
  all of them, up to 100 files per request, instead of GitHub's one request at a time through
  the whole PR. Applies to the new Files changed page.
- **Load the rest in the background.** Then every other file is fetched the same way, so
  switching tabs is instant and makes no requests. Turn it off to load only the open tab
  (other tabs load when you open them); GitHub's large-PR list is used for that, so Find on
  Page then only sees diffs near the screen.
- **Parallel diff loading.** GitHub's loader sends one diff request at a time. Large batches
  are split into requests of up to 20 files that run 6 at a time and are merged back; when
  GitHub drives loading itself (4 files per request), a page script (`prefetch.js`) fetches
  ahead about 5 requests at a time and answers GitHub's queued requests. A failed part falls
  back to GitHub's own request or fails it as GitHub would.

The classic Files changed page already loads every diff in two requests, so it is left as is;
switching tabs there makes no requests either.

Trade-offs: GitHub's own file tree and "viewed" counter show the open tab's files. The page
scripts reach GitHub's store through React internals; if those change they do nothing and
tabs fall back to hiding files with CSS. How it all works: [ARCHITECTURE.md](ARCHITECTURE.md).

## Benchmarks

Measured 2026-10-17 on [react/react#37778](https://github.com/react/react/pull/37778/changes)
(167 files), headless Chrome, opening on the Source tab (96 files), 2 runs each. Times are from
navigation start; GitHub itself takes about 4-5.7 s before its first diff request. "Before" is
v0.3.0 (diffs loaded on demand as they neared the screen).

**New page**

| | Before | Defaults | Background load off |
|---|---|---|---|
| All Source diffs loaded | only when scrolled to | 6.7-8.1 s | 5.6-6.5 s |
| Whole PR loaded | never | 8.1-8.8 s | never (by design) |
| Diff requests during load | 2 | 11-12 | 5-7 |
| Diff requests on 5 tab switches afterwards | 6-8 | **0** | 9 (other tabs load when opened) |

Without the extension GitHub needs 42 sequential requests, 30-45 s, for the whole PR.

**Larger PRs** (new page, opening on Source, logged in, 2 runs). "GitHub alone" is this build
with every experiment off: GitHub switches these three to its large-PR list by itself, so
without the extension diffs only load as you scroll to them. v0.4.0 loaded one batch at a time;
now batches are split into parallel requests (Parallel diff loading).

| PR | Files (Source) | GitHub alone after 90 s | Source loaded, v0.4.0 → now | Whole PR loaded, v0.4.0 → now |
|---|---|---|---|---|
| [react/react#37778](https://github.com/react/react/pull/37778/changes) | 167 (96) | (not virtualized) | 6.4-8.4 s → **5.2-6.1 s** | 6.8-8.4 s → **6.5-6.6 s** |
| [microsoft/vscode#151512](https://github.com/microsoft/vscode/pull/151512/changes) | 898 (617) | 22 files | 30-35 s → **19-20 s** | 40-48 s → **22-23 s** |
| [kubernetes/kubernetes#102196](https://github.com/kubernetes/kubernetes/pull/102196/changes) | 336 (286) | 8 files | 11 s → **7 s** | 12 s → **7.4-8.2 s** |
| [vercel/next.js#78559](https://github.com/vercel/next.js/pull/78559/changes) | 770 (60) | 9 files | 11-12 s → 11-12 s | 44-48 s → **19 s** |

Tab switches after loading made **0 requests** on every PR (GitHub alone: 3-6 per 5 switches).

**Classic page** (logged out, cold browser cache)

| | Before | Now |
|---|---|---|
| All Source diffs loaded | only when scrolled to | 1.9-7.4 s (with every other diff) |
| Diff requests | 7 | 2 |
| Diff requests on 5 tab switches afterwards | 19 | **0** |

**Opening on All** (Parallel diff loading, measured 2026-10-16): every diff loaded in 11-15 s
instead of 35-47 s, about 5 requests in flight instead of 1.

Not measured yet: main-thread and memory cost, and arriving at a PR from elsewhere on GitHub
without a reload.

## Notes

- Reads the file list GitHub embeds in the page (on the classic page, its file tree), so
  counts are complete on load and files are hidden with a stylesheet before they render.
  Falls back to scanning the page when that data is missing or stale.
- Relies on GitHub's current Files changed markup; selectors may need updating if it changes.

## Build and release

- `scripts/build.sh` checks the scripts and the manifest and writes
  `dist/pr-files-tabs-<version>.zip`. CI runs it on every push and pull request and keeps
  the zip as a build artifact.
- To release, bump `version` in `manifest.json`, commit, then tag and push it:
  `git tag v0.4.0 && git push origin v0.4.0`. CI creates a GitHub release with the zip and,
  once the store secrets are set, uploads and publishes it to the Chrome Web Store.
- `store/` has the store listing, privacy policy, screenshots and promo images
  (`store/render.sh` redraws the icons and promo tiles). See [store/README.md](store/README.md).

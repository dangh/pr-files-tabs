# Chrome Web Store

Everything needed to list and publish Sift for GitHub. Images are regenerated with
`store/render.sh` (headless Chrome).

## Assets

| File | Store field | Size |
|---|---|---|
| `../icons/icon-128.png` | Store icon | 128x128 (96x96 artwork, 16 px padding) |
| `screenshots/1-tests-tab.png` | Screenshot | 1280x800 |
| `screenshots/2-manifest-tab.png` | Screenshot | 1280x800 |
| `screenshots/3-classic-page.png` | Screenshot | 1280x800 |
| `screenshots/4-options.png` | Screenshot | 1280x800 |
| `promo/small-tile.png` | Small promo tile | 440x280 |
| `promo/marquee.png` | Marquee promo tile | 1400x560 |
| `promo/social-preview.png` | GitHub repo social preview (Settings > Social preview) | 1280x640 |

Screenshots use a public PR (react/react#37778), with the signed-in account's avatar hidden.

## Listing

**Name:** Sift for GitHub

**Summary** (132 characters max):
Split GitHub pull request files into tabs like Source, Tests and Manifest, and load the tab you're on first.

**Category:** Developer Tools. **Language:** English.

**Description:**

> Big pull requests mix source changes with tests, lock files and generated files.
> Sift for GitHub adds tabs to GitHub's Files changed page so you can review one kind at a time.
>
> - Tabs for Source, Tests, Docs, Infra (serverless, CDK, Terraform, Docker, CI), Manifest
>   (dependencies, readmes, changelogs) and Artifacts (build output, minified and generated code)
>   out of the box, with file counts.
> - Make your own tabs with simple patterns: globs like `package*.json`, paths like
>   `services/*/lib/*`, folders like `test/` (gitignore syntax), and exclusions like `!Manifest`.
> - Pick the tab a PR opens on; the tab you choose on a PR is remembered across refreshes.
> - The file tree follows the tab you're on.
> - Works on both the new and the classic Files changed page.
>
> Faster big PRs (experimental, on by default):
> - Load the open tab first: when a PR opens on a tab, all of that tab's diffs load first, in
>   large batches, instead of GitHub's one request at a time through the whole PR.
> - Load the rest in the background: then every other diff loads, so switching tabs is
>   instant and makes no more requests.
> - Parallel diff loading: when GitHub loads diffs a few at a time, they load several requests
>   at a time instead of one after another.
>
> No account, no tracking. Settings stay in your browser.

## Privacy tab

**Single purpose:** Organize the files on a GitHub pull request's Files changed page into
configurable tabs, and load only the diffs needed for the open tab.

**Permission justifications:**
- `storage`: saves the user's tab configuration and settings.
- Host access (content scripts on `https://github.com/*/*/pull/*`): adds the tabs to the pull
  request page and changes which diffs GitHub loads there. It runs on no other site.

**Remote code:** No. All code ships in the package.

**Data usage:** Collects no user data. Nothing is sent anywhere. The configuration is kept in
`chrome.storage.sync`, plus a copy in github.com's `localStorage` in the user's own browser
so the page scripts can read it (see `PRIVACY.md`).

**Privacy policy URL:** needs a public URL for `store/PRIVACY.md`. This repository is private,
so publish it somewhere public first (GitHub Pages, a gist, or a public repo).

## Store item

Published from the personal account (publisher "Dang H."); item ID
`jkdaphdpihedahfccnneeloflldfejnn`, listing https://chromewebstore.google.com/detail/jkdaphdpihedahfccnneeloflldfejnn. Version 0.6.0 was submitted by hand on
2026-10-17. The privacy policy URL is
https://github.com/dangh/sift-for-github/blob/main/store/PRIVACY.md.

## Automatic publishing

CI uploads and publishes every `v*` tag. All four repository secrets are set
(Settings > Secrets and variables > Actions):

| Secret | Where it comes from |
|---|---|
| `CWS_EXTENSION_ID` | The item's ID in the developer dashboard |
| `CWS_CLIENT_ID` | OAuth client "sift-ci-publish" (Desktop app) in Google Cloud project `sift-for-github-publish`, Chrome Web Store API enabled, consent screen in production |
| `CWS_CLIENT_SECRET` | The same OAuth client |
| `CWS_REFRESH_TOKEN` | Generated for that client; see the [chrome-webstore-upload keys guide](https://github.com/fregante/chrome-webstore-upload-keys) |

Without them the publish job is skipped with a notice, and the release still gets the zip.
Treat these as credentials: anyone holding them can publish a new version of the extension.

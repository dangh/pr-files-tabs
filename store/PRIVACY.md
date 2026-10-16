# PR Files Tabs privacy policy

PR Files Tabs does not collect, store on any server, sell or share any personal data.

**What it reads.** On GitHub pull request pages (`https://github.com/*/*/pull/*`) it reads the
list of changed files and the page's own data, in your browser, to sort files into tabs and
decide which diffs GitHub loads. It runs on no other site.

**What it stores.** Your tab configuration and settings, in `chrome.storage.sync` (synced
by Chrome to your Google account if you have sync on). A copy of the same configuration is
kept in github.com's `localStorage` in your browser so the extension's page scripts can read
it before the page loads; GitHub's own scripts on that page could read it too. The tab you
last picked on each pull request is kept in the browser tab's `sessionStorage`.

**What it sends.** Nothing about you. Its only network requests go to github.com, for the diffs
of the pull request you are viewing, using your existing GitHub session.

**Contact.** Open an issue in the project's repository.

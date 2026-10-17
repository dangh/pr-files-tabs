(function () {
  let config = SIFT.DEFAULTS;
  let compiled = SIFT.compileConfig(config);
  let active = 'all';
  let activeFor = null;
  // True until the full file list is known, if the PR opened on the default tab.
  let onDefault = false;
  let ready = false;
  let timer = null;
  // Kept even while GitHub has thrown it out of the page, so it can be put back as is.
  let barEl = null;

  function prKey() {
    return SIFT.prKey(location.pathname);
  }

  function saveChoice(pr, tabs, key) {
    let value = 'all';
    let tab = tabs.find((t) => t.key === key);
    if (key !== 'all' && tab) {
      value = 'tab:' + tab.label;
    }
    try {
      sessionStorage.setItem('sift:' + pr, value);
    } catch (e) {
      // storage unavailable; the choice just won't persist
    }
  }

  function tabList() {
    return SIFT.tabList(config);
  }

  // page.js runs before chrome.storage can answer and can't reach it anyway, so it reads this copy.
  function shareConfig() {
    try {
      localStorage.setItem('sift:config', JSON.stringify(config));
    } catch (e) {
      // storage unavailable; page.js then leaves GitHub's loading alone
    }
  }

  function pathOf(container) {
    let raw = container.getAttribute('data-tagsearch-path') || '';
    if (!raw) {
      let header = container.querySelector('h3 code, h3, [class*="file-name"]');
      if (header) {
        // Renames separate old and new path with an SVG arrow, not text.
        let copy = header.cloneNode(true);
        for (let svg of copy.querySelectorAll('svg')) {
          svg.replaceWith('\u2192');
        }
        raw = copy.textContent;
      }
    }
    // The new path decides the bucket for renames.
    let parts = raw.replace(/[\u200e\u200f\u202a-\u202e]/g, '').split('\u2192');
    return parts.pop().trim();
  }

  function findContainers() {
    let all = document.querySelectorAll('[id^="diff-"], .file[data-tagsearch-path]');
    let valid = [];
    for (let el of all) {
      if (/^diff-[0-9a-f]{16,}$/.test(el.id) || el.hasAttribute('data-tagsearch-path')) {
        valid.push(el);
      }
    }
    // Drop any match nested inside another match (e.g. classic UI line cells).
    return valid.filter((el) => !valid.some((other) => other !== el && other.contains(el)));
  }

  // GitHub wraps each diff in an entry that reserves its own height and list gap, so the
  // wrapper has to be hidden too. Walk up while the parent holds only this one child.
  function slotOf(el) {
    let slot = el;
    // A virtualized row (data-index) is the outermost per-file wrapper; its parent is the list.
    while (!slot.hasAttribute('data-index') && slot.parentElement && slot.parentElement.children.length === 1 && slot.parentElement.tagName === 'DIV') {
      slot = slot.parentElement;
    }
    return slot;
  }

  function labelOf(item) {
    let text = item.querySelector('[class*="item-content-text"]') || item.querySelector('span');
    return text?.textContent.trim() || '';
  }

  function treePathOf(item) {
    // Tree rows carry their full path as the element id.
    if (item.id) {
      return item.id;
    }
    let parts = [labelOf(item)];
    let parent = item.parentElement?.closest('li[role="treeitem"]');
    while (parent) {
      parts.unshift(labelOf(parent));
      parent = parent.parentElement?.closest('li[role="treeitem"]');
    }
    return parts.join('/');
  }

  // The classic page's tree rows are li#file-tree-item-diff-<digest>; its folders have no
  // aria-expanded.
  const CLASSIC_TREE_FILE = 'file-tree-item-diff-';

  function isTreeFolder(item) {
    return item.hasAttribute('aria-expanded') || item.dataset.treeEntryType === 'directory';
  }

  // Files resolve through their diff id (classic tree rows, or the diff anchor they link to),
  // falling back to the path built from labels.
  function heldForTreeFile(item, bucketByPath, bucketByDiffId) {
    if (item.id.startsWith(CLASSIC_TREE_FILE)) {
      return bucketByDiffId.get('diff-' + item.id.slice(CLASSIC_TREE_FILE.length));
    }
    let href = item.querySelector('a[href*="#diff-"]')?.getAttribute('href') || '';
    return bucketByDiffId.get(href.slice(href.indexOf('#') + 1)) || bucketByPath.get(treePathOf(item));
  }

  function showTreeItem(item, visible) {
    if (visible) {
      delete item.dataset.siftHidden;
    } else {
      item.dataset.siftHidden = '1';
    }
  }

  // Filters the left file tree. Folders stay only if they hold a visible file.
  function filterTree(bucketByPath, bucketByDiffId) {
    let items = [...document.querySelectorAll('[role="tree"] li[role="treeitem"]')];
    let activePaths = [];
    for (let [path, held] of bucketByPath) {
      if (active === 'all' || held.has(Number(active))) {
        activePaths.push(path);
      }
    }
    // Files first, so folders can check what they still show.
    for (let item of items.filter((i) => !isTreeFolder(i))) {
      let held = heldForTreeFile(item, bucketByPath, bucketByDiffId);
      showTreeItem(item, active === 'all' || Boolean(held?.has(Number(active))));
    }
    for (let item of items.filter(isTreeFolder)) {
      let visible = true;
      if (active !== 'all') {
        let files = [...item.querySelectorAll('li[role="treeitem"]')].filter((i) => !isTreeFolder(i));
        // Collapsed folders on the new page don't render their rows; fall back to paths.
        visible = files.length > 0
          ? files.some((f) => !f.dataset.siftHidden)
          : activePaths.some((p) => p.startsWith(treePathOf(item) + '/'));
      }
      showTreeItem(item, visible);
    }
  }

  function onFilesPage() {
    return /\/pull\/\d+\/(files|changes)/.test(location.pathname);
  }

  // GitHub embeds the whole PR's file list in the initial page (digest = the diff element id
  // suffix), so every file is known before the lazy diff list renders.
  let summaryCache = new WeakMap();

  // The classic page embeds no file list, but its file tree lists every file up front.
  function readClassicTree() {
    let first = document.querySelector('li[id^="' + CLASSIC_TREE_FILE + '"][data-tree-entry-type="file"]');
    if (!first) {
      return null;
    }
    if (!summaryCache.has(first)) {
      let map = new Map();
      try {
        for (let item of document.querySelectorAll('li[id^="' + CLASSIC_TREE_FILE + '"][data-tree-entry-type="file"]')) {
          let path = JSON.parse(item.dataset.hydroClickPayload).payload.data.path;
          map.set(item.id.slice(CLASSIC_TREE_FILE.length), path);
        }
      } catch (e) {
        // markup changed; fall back to the rendered diffs
        map = null;
      }
      summaryCache.set(first, map);
    }
    return summaryCache.get(first);
  }

  // page.js's copy of the file list in GitHub's store: always the PR on screen.
  let storeList = { text: null, map: null };

  function readStoreList() {
    let text = document.getElementById('sift-files')?.textContent || null;
    if (text !== storeList.text) {
      let map = null;
      try {
        let list = JSON.parse(text);
        if (Array.isArray(list) && list.length > 0) {
          map = new Map(list);
        }
      } catch (e) {
        // not written yet
      }
      storeList = { text, map };
    }
    return storeList.map;
  }

  function readSummary() {
    let classic = readClassicTree();
    if (classic) {
      return classic;
    }
    let fromStore = readStoreList();
    if (fromStore) {
      return fromStore;
    }
    let number = location.pathname.match(/\/pull\/(\d+)/)?.[1];
    for (let script of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
      if (!summaryCache.has(script)) {
        let entry = null;
        try {
          let route = JSON.parse(script.textContent)?.payload?.pullRequestsChangesRoute;
          let list = route?.diffSummaries;
          if (Array.isArray(list) && list.length > 0) {
            entry = { number: route.pullRequest?.number, map: new Map(list.map((s) => [s.pathDigest, s.path])) };
          }
        } catch (e) {
          // not the script we want
        }
        summaryCache.set(script, entry);
      }
      let entry = summaryCache.get(script);
      // The embedded data stays on the first PR after in-app navigation to another one.
      if (entry && (entry.number === undefined || String(entry.number) === number)) {
        return entry.map;
      }
    }
    return null;
  }

  // Hiding by stylesheet applies the moment GitHub renders a file, so there is no flash
  // of unfiltered files while the list loads.
  function writeFilterStyle(files, heldByDiffId) {
    let rules = [];
    if (active !== 'all') {
      for (let file of files) {
        if (!heldByDiffId.get('diff-' + file.digest).has(Number(active))) {
          rules.push(SIFT.hideCss(file.digest, file.path));
        }
      }
    }
    let css = rules.join('\n');
    let style = document.getElementById('sift-filter');
    if (!style) {
      style = document.createElement('style');
      style.id = 'sift-filter';
      document.head.append(style);
    }
    if (style.textContent !== css) {
      style.textContent = css;
    }
  }

  function render() {
    if (!ready) {
      return;
    }
    let bar = barEl;
    if (!onFilesPage()) {
      bar?.remove();
      document.getElementById('sift-filter')?.remove();
      delete document.documentElement.dataset.siftActive;
      return;
    }

    let containers = findContainers();
    let summary = readSummary();
    // A rendered diff missing from the embedded list means the list is stale (e.g. the
    // commit range changed without a page load); fall back to the DOM.
    if (summary && containers.some((el) => !summary.has(el.id.replace(/^diff-/, '')))) {
      summary = null;
    }
    if (containers.length === 0 && !summary) {
      return;
    }

    let tabs = tabList();
    let pr = prKey();
    if (activeFor !== pr) {
      activeFor = pr;
      active = SIFT.initialKey(config, pr);
      onDefault = !SIFT.readSaved(pr);
    }
    if (!tabs.some((t) => t.key === active)) {
      active = 'all';
    }

    let files = [];
    if (summary) {
      for (let [digest, path] of summary) {
        files.push({ digest, path });
      }
    } else {
      for (let el of containers) {
        files.push({ digest: el.id.replace(/^diff-/, ''), path: pathOf(el) });
      }
    }

    let counts = { all: files.length };
    for (let tab of tabs) {
      counts[tab.key] = counts[tab.key] || 0;
    }
    let bucketByPath = new Map();
    let bucketByDiffId = new Map();
    for (let file of files) {
      let held = SIFT.classify(compiled, file.path);
      bucketByPath.set(file.path, held);
      bucketByDiffId.set('diff-' + file.digest, held);
      for (let index of held) {
        counts[String(index)] += 1;
      }
    }
    // A PR opened on the default tab shows All when that tab has none of its files. Only the full
    // list can tell; rendered diffs may be just the open tab's.
    if (summary && onDefault) {
      onDefault = false;
      if (counts[active] === 0) {
        active = 'all';
      }
    }
    // page.js watches this to hand GitHub only the open tab's files.
    if (document.documentElement.dataset.siftActive !== active) {
      document.documentElement.dataset.siftActive = active;
    }
    let hide = new Set();
    for (let el of containers) {
      let held = bucketByDiffId.get(el.id);
      if (active !== 'all' && !held.has(Number(active))) {
        hide.add(slotOf(el));
      }
    }
    // A wrapper that held a single hidden diff can later hold more (GitHub's virtualized list
    // reuses its row container), so drop every mark this pass doesn't set again.
    for (let el of document.querySelectorAll('[data-sift-hidden]:not(li[role="treeitem"])')) {
      if (!hide.has(el)) {
        delete el.dataset.siftHidden;
      }
    }
    for (let slot of hide) {
      slot.dataset.siftHidden = '1';
    }
    if (summary) {
      writeFilterStyle(files, bucketByDiffId);
    } else {
      document.getElementById('sift-filter')?.remove();
    }

    filterTree(bucketByPath, bucketByDiffId);

    if (!bar) {
      bar = barEl = document.createElement('div');
      bar.id = 'sift-bar';
      bar.setAttribute('role', 'tablist');
      bar.addEventListener('change', function (event) {
        if (event.target.matches('select.sift-select')) {
          active = event.target.value;
          saveChoice(prKey(), tabList(), active);
          render();
        }
      });
      bar.addEventListener('click', function (event) {
        let btn = event.target.closest('button[data-key]');
        if (btn) {
          active = btn.dataset.key;
          saveChoice(prKey(), tabList(), active);
          render();
        }
      });
    }

    // With hideEmptyTabs, tabs with no files are left out, except All and the open tab.
    let shown = tabs.filter((t) => t.key === 'all' || t.key === active || config.hideEmptyTabs === false || counts[t.key] > 0);
    let signature = shown.map((t) => t.key + t.label + counts[t.key] + (t.key === active)).join('|');
    if (bar.dataset.sig !== signature) {
      bar.dataset.sig = signature;
      bar.textContent = '';
      let group = document.createElement('div');
      group.className = 'sift-tabs';
      bar.append(group);
      for (let tab of shown) {
        let btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.key = tab.key;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(tab.key === active));
        btn.append(tab.label);
        let count = document.createElement('span');
        count.className = 'sift-count';
        count.textContent = String(counts[tab.key]);
        btn.append(count);
        group.append(btn);
      }
      // Shown instead of the buttons when the toolbar is too narrow (see fit()).
      let select = document.createElement('select');
      select.className = 'sift-select';
      select.setAttribute('aria-label', 'File filter');
      for (let tab of shown) {
        select.append(new Option(tab.label + ' (' + counts[tab.key] + ')', tab.key));
      }
      select.value = active;
      bar.append(select);
    }

    placeBar(bar, containers[0]);
    fit(bar);
  }

  // The classic page's sticky toolbar row ("Changes from all commits", File filter, ...).
  function classicRow() {
    return document.querySelector('.pr-toolbar .diffbar .d-flex.flex-items-center.flex-wrap');
  }

  // Collapse the buttons into a dropdown when the toolbar row can't hold them all.
  function fit(bar) {
    bar.classList.remove('sift-compact');
    if (!bar.classList.contains('sift-inline')) {
      return;
    }
    let row = classicRow();
    if (row && bar.parentElement === row) {
      // The classic row wraps instead of overflowing; compact if the bar wrapped to a new line.
      let first = [...row.children].find((c) => c.offsetWidth > 0);
      if (first && bar.offsetTop > first.offsetTop + first.offsetHeight / 2) {
        bar.classList.add('sift-compact');
      }
      return;
    }
    let toolbar = bar.closest('section');
    if (!toolbar) {
      return;
    }
    let used = 0;
    for (let child of toolbar.children) {
      used += child.offsetWidth;
    }
    let right = bar.parentElement;
    let natural = used - right.offsetWidth + right.scrollWidth;
    if (natural + 32 > toolbar.clientWidth) {
      bar.classList.add('sift-compact');
    }
  }

  // Prefer the sticky toolbar row: on the new page left of the viewed counter and Submit review,
  // on the classic page at the end of the row with "Changes from all commits".
  // Fall back to just above the first diff on pages without that toolbar.
  function placeBar(bar, firstDiff) {
    let row = classicRow();
    if (row) {
      bar.classList.add('sift-inline');
      // Last item of the row, pushed to the right by the bar's auto margin.
      if (bar.parentElement !== row || row.lastElementChild !== bar) {
        row.append(bar);
      }
      return;
    }
    let review = [...document.querySelectorAll('button')].find((b) => /Submit review/.test(b.textContent));
    let toolbar = review?.closest('section');
    let anchor = review;
    while (toolbar && anchor && anchor.parentElement !== toolbar) {
      anchor = anchor.parentElement;
    }
    if (toolbar && anchor) {
      bar.classList.add('sift-inline');
      // First child of the right-hand group, i.e. just left of the viewed counter.
      if (bar.parentElement !== anchor || anchor.firstElementChild !== bar) {
        anchor.insertBefore(bar, anchor.firstElementChild);
      }
      return;
    }
    bar.classList.remove('sift-inline');
    // On the classic page the diff sits in a copilot-diff-entry that gets hidden with it.
    let before = firstDiff?.closest('copilot-diff-entry') || firstDiff;
    if (before && bar.nextElementSibling !== before) {
      before.parentElement.insertBefore(bar, before);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, 200);
  }

  // GitHub re-renders its toolbar while the page loads (e.g. when the file list changes), which
  // throws the bar out. Put it back right away: observer callbacks run before the next paint, so
  // the bar never visibly disappears.
  function restoreBar() {
    let bar = barEl;
    if (bar && !bar.isConnected && ready && onFilesPage()) {
      placeBar(bar, findContainers()[0]);
      fit(bar);
    }
  }

  // GitHub is a SPA and lazily renders diffs, so re-run on DOM changes (debounced).
  window.addEventListener('resize', schedule);
  new MutationObserver(function () {
    restoreBar();
    schedule();
  }).observe(document.body, { childList: true, subtree: true });
  // page.js has a new file list (a new PR, or new commits).
  document.addEventListener('sift:files', schedule);

  chrome.storage.onChanged.addListener(async function (changes) {
    if (changes.config) {
      config = await SIFT.load();
      compiled = SIFT.compileConfig(config);
      shareConfig();
      render();
    }
  });

  SIFT.load().then(function (loaded) {
    config = loaded;
    compiled = SIFT.compileConfig(config);
    shareConfig();
    ready = true;
    render();
  });
})();

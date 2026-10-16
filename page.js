// Runs in GitHub's own JS world at document_start, so it can adjust GitHub's page data
// before GitHub reads it.
(function () {
  const EMBEDDED = 'script[data-target="react-app.embeddedData"]';

  function cachedConfig() {
    try {
      return JSON.parse(localStorage.getItem('ghpt:config'));
    } catch (e) {
      return null;
    }
  }

  function experiments(config) {
    return { tabFirst: config.experiments?.onDemandDiffs !== false, background: config.experiments?.backgroundLoad !== false };
  }

  // True when the PR at pathname opens on a tab other than All with "Load the open tab first" on.
  function opensOnTab(pathname) {
    let config = cachedConfig();
    if (!config?.tabs || !experiments(config).tabFirst) {
      return false;
    }
    let pr = GHPT.prKey(pathname);
    return Boolean(pr) && GHPT.initialKey(config, pr) !== 'all';
  }

  // True when only the open tab should load: it opens on a tab and the background load is off.
  // GitHub's normal list would fetch every file anyway, one request at a time, so switch to its
  // virtualized list (normally reserved for huge PRs), which fetches only what it's asked for
  // and what is near the viewport. With the background load on, everything is fetched anyway
  // and the normal list keeps Find on Page working.
  function onlyOpenTab(pathname) {
    return opensOnTab(pathname) && !experiments(cachedConfig()).background;
  }

  function patch(data, pathname) {
    let route = data?.payload?.pullRequestsChangesRoute;
    if (!route || route.virtualizeDiffEntries || !onlyOpenTab(pathname)) {
      return false;
    }
    route.virtualizeDiffEntries = true;
    return true;
  }

  // Returns false while the script's JSON is still incomplete.
  function patchScript(script) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch (e) {
      return false;
    }
    if (patch(data, location.pathname)) {
      script.textContent = JSON.stringify(data);
    }
    return true;
  }

  // GitHub keeps the PR's file list in a store that its diff list and file tree read, next to
  // its diff loader. Handing it only the open tab's files makes the list render just those (no
  // gaps in the virtualized list), and the loader's loadManyPriority() fetches a whole list of
  // files in one request. The store is reached through React internals; if anything looks
  // different GitHub is left alone and content.js still hides files with CSS.
  let store = null;
  let full = null;
  let shown = null;
  let lastLookup = 0;

  function findStore() {
    // Other elements also have ids starting with "diff-" (e.g. the comparison picker).
    let el = document.querySelector('[data-testid="virtualized-diffs-list"]') ||
      [...document.querySelectorAll('[id^="diff-"]')].find((e) => /^diff-[0-9a-f]{16,}$/.test(e.id));
    let key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let fiber = el?.[key], depth = 0; fiber && depth < 200; fiber = fiber.return, depth++) {
      let value = fiber.memoizedProps?.value;
      if (typeof value?.getState === 'function' && value.getState()?.diffSummariesActions?.setDiffSummaries) {
        return value;
      }
    }
    return null;
  }

  function sameKeys(a, b) {
    let keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b);
  }

  function track(found) {
    store = found;
    full = { ...found.getState().diffSummaries };
    shown = null;
    found.subscribe(function (state) {
      if (store !== found || state.diffSummaries === shown) {
        return;
      }
      if (shown && sameKeys(state.diffSummaries, shown)) {
        // GitHub updated files it was handed (e.g. one marked viewed); keep those versions.
        Object.assign(full, state.diffSummaries);
        shown = state.diffSummaries;
        return;
      }
      // GitHub loaded a new file list (e.g. new commits pushed); it becomes the full list.
      full = { ...state.diffSummaries };
      shown = null;
      apply();
    });
    apply();
  }

  function apply() {
    let key = document.documentElement.dataset.ghptActive;
    let config = cachedConfig();
    if (!store || !key || !config?.tabs || !experiments(config).tabFirst) {
      return;
    }
    let next = full;
    if (key !== 'all') {
      let compiled = GHPT.compileConfig(config);
      next = {};
      for (let [path, summary] of Object.entries(full)) {
        if (GHPT.classify(compiled, path).has(Number(key))) {
          next[path] = summary;
        }
      }
    }
    // On All, GitHub already has every file unless we swapped a tab in before.
    if (key !== 'all' || shown) {
      // Set first: the store notifies subscribers synchronously.
      shown = next;
      store.getState().diffSummariesActions.setDiffSummaries(next);
    }
    loadFiles(Object.values(next).map((summary) => summary.pathDigest), experiments(config).background);
  }

  // Files per loadManyPriority() call; GitHub fetches each call's files in one request.
  const LOAD_BATCH = 100;
  let loadRun = 0;

  function isLoaded(target, digest) {
    return Boolean(target.getState().entriesMap?.[digest]?.isLoaded);
  }

  // Asks GitHub's loader for the digests and resolves once it has them all, or after a while: a
  // failed request leaves files "in flight" in GitHub's loader for good. The virtualized list
  // keeps queueing its own small loads, which makes the loader take ours a few at a time, so
  // whatever is still missing is asked for again every second (files already loaded or in
  // flight are skipped by the loader).
  function loadAndWait(target, digests) {
    return new Promise(function (resolve) {
      let missing = () => digests.filter((d) => !isLoaded(target, d));
      let started = Date.now();
      let timer = null;
      let unsubscribe = null;
      function ask() {
        let rest = missing();
        if (rest.length === 0 || Date.now() - started > 20000) {
          finish();
          return;
        }
        target.getState().progressiveDiffsActions.loadManyPriority(rest);
        timer = setTimeout(ask, 1000);
      }
      function finish() {
        clearTimeout(timer);
        unsubscribe?.();
        resolve();
      }
      unsubscribe = target.subscribe(function () {
        if (missing().length === 0) {
          finish();
        }
      });
      ask();
    });
  }

  // One batch at a time: the loader serves loadManyPriority() calls last-in first-out, so
  // queueing several at once would scramble the order.
  async function loadInBatches(target, digests, run) {
    for (let i = 0; i < digests.length; i += LOAD_BATCH) {
      let batch = digests.slice(i, i + LOAD_BATCH).filter((d) => !isLoaded(target, d));
      if (run !== loadRun || store !== target) {
        return;
      }
      if (batch.length > 0) {
        await loadAndWait(target, batch);
      }
    }
  }

  // Fetch every file of the open tab, then (background experiment) every other file, so that
  // switching tabs needs no more requests. A tab switch starts a new run, which goes first.
  async function loadFiles(tabDigests, background) {
    let target = store;
    if (!target.getState().progressiveDiffsActions?.loadManyPriority || !target.getState().entriesMap) {
      return;
    }
    let run = ++loadRun;
    await loadInBatches(target, tabDigests, run);
    if (background) {
      await loadInBatches(target, Object.keys(target.getState().entriesMap), run);
    }
  }

  // A new PR page (or in-app navigation) mounts a new store.
  function lookForStore() {
    if (Date.now() - lastLookup < 300) {
      return;
    }
    lastLookup = Date.now();
    let found = findStore();
    if (found && found !== store) {
      track(found);
    }
  }

  // The parser streams large JSON into the script's existing text node, which fires no
  // childList record, so an incomplete script is retried on every later batch of DOM changes
  // (the parser keeps adding nodes long before GitHub's deferred bundles read the data).
  let pending = new Set();
  // document.documentElement doesn't exist yet at document_start.
  new MutationObserver(function (records) {
    let tabChanged = false;
    for (let record of records) {
      tabChanged ||= record.type === 'attributes';
      for (let node of record.addedNodes) {
        if (node.nodeType === 1 && node.matches(EMBEDDED)) {
          pending.add(node);
        }
      }
    }
    for (let script of pending) {
      if (patchScript(script)) {
        pending.delete(script);
      }
    }
    lookForStore();
    if (tabChanged) {
      apply();
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ghpt-active'] });

  // In-app navigation to the Files changed page fetches the same page data as JSON.
  let originalFetch = window.fetch;
  window.fetch = function (input) {
    let url;
    try {
      url = new URL(String(input?.url ?? input), location.href);
    } catch (e) {
      return originalFetch.apply(this, arguments);
    }
    let request = originalFetch.apply(this, arguments);
    if (!/\/pull\/\d+\/(changes|files)\/?$/.test(url.pathname)) {
      return request;
    }
    return request.then(async function (response) {
      if (!response.headers.get('content-type')?.includes('json')) {
        return response;
      }
      try {
        let data = await response.clone().json();
        if (patch(data, url.pathname)) {
          let { status, statusText, headers } = response;
          return new Response(JSON.stringify(data), { status, statusText, headers });
        }
      } catch (e) {
        // not the page data; hand GitHub the original
      }
      return response;
    });
  };
})();

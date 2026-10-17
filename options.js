let tabsEl = document.getElementById('tabs');
let template = document.getElementById('tab-template');
let defaultEl = document.getElementById('default');
let statusEl = document.getElementById('status');
let hideEmptyEl = document.getElementById('hide-empty');
let onDemandEl = document.getElementById('on-demand');
let backgroundEl = document.getElementById('background');
let parallelEl = document.getElementById('parallel');
let probeEl = document.getElementById('probe');
let resultEl = document.getElementById('result');
const PROBE_HINT = resultEl.textContent;

// Comments are fine; a pattern that matches nothing (e.g. a bare "!" or "/") is not.
function invalidPattern(text) {
  return text.split('\n').map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !SIFT.compile(p.replace(/^!/, '')));
}

// Flags a bad pattern under its own tab as you type.
function check(box) {
  let area = box.querySelector('.patterns');
  let bad = invalidPattern(area.value);
  area.setAttribute('aria-invalid', String(Boolean(bad)));
  let error = box.querySelector('.error');
  error.hidden = !bad;
  error.textContent = bad ? 'Invalid pattern: ' + bad : '';
  return bad;
}

function refreshButtons() {
  let boxes = [...tabsEl.children];
  boxes.forEach((box, i) => {
    box.querySelector('[data-action="up"]').disabled = i === 0;
    box.querySelector('[data-action="down"]').disabled = i === boxes.length - 1;
  });
}

function addTab(tab) {
  let box = template.content.firstElementChild.cloneNode(true);
  box.querySelector('.label').value = tab.label;
  box.querySelector('.patterns').value = tab.patterns.join('\n');
  tabsEl.append(box);
  check(box);
  refreshButtons();
  return box;
}

function refreshDefaults(selected) {
  let current = selected === undefined ? defaultEl.value : selected;
  defaultEl.textContent = '';
  defaultEl.append(new Option('All', ''));
  for (let box of tabsEl.children) {
    let label = box.querySelector('.label').value.trim();
    if (label) {
      defaultEl.append(new Option(label, label));
    }
  }
  defaultEl.value = current;
  // A default tab that was renamed or deleted falls back to All.
  if (defaultEl.value !== current) {
    defaultEl.value = '';
  }
}

function show(config) {
  tabsEl.textContent = '';
  for (let tab of config.tabs) {
    addTab(tab);
  }
  refreshDefaults(config.defaultTab || '');
  hideEmptyEl.checked = config.hideEmptyTabs !== false;
  onDemandEl.checked = config.experiments.onDemandDiffs;
  backgroundEl.checked = config.experiments.backgroundLoad;
  parallelEl.checked = config.experiments.parallelLoad;
}

function read() {
  let tabs = [];
  for (let box of tabsEl.children) {
    let label = box.querySelector('.label').value.trim();
    let patterns = box.querySelector('.patterns').value.split('\n').map((p) => p.trim()).filter(Boolean);
    if (label) {
      tabs.push({ label, patterns });
    }
  }
  let experiments = { onDemandDiffs: onDemandEl.checked, backgroundLoad: backgroundEl.checked, parallelLoad: parallelEl.checked };
  return { tabs, defaultTab: defaultEl.value, hideEmptyTabs: hideEmptyEl.checked, experiments };
}

let statusTimer = null;

function flash(text, negative) {
  statusEl.textContent = text;
  statusEl.className = negative ? 'bad' : 'ok';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 2500);
}

function probe() {
  let path = probeEl.value.trim();
  if (!path) {
    resultEl.textContent = PROBE_HINT;
    return;
  }
  let config = read();
  let held = SIFT.classify(SIFT.compileConfig(config), path);
  let labels = [...held].map((i) => config.tabs[i].label);
  resultEl.textContent = '→ ' + (labels.join(', ') || 'No tab (only shown under All)');
}

tabsEl.addEventListener('click', function (event) {
  let btn = event.target.closest('button[data-action]');
  if (!btn) {
    return;
  }
  let box = btn.closest('.tab');
  if (btn.dataset.action === 'delete') {
    box.remove();
  }
  if (btn.dataset.action === 'up' && box.previousElementSibling) {
    box.previousElementSibling.before(box);
  }
  if (btn.dataset.action === 'down' && box.nextElementSibling) {
    box.nextElementSibling.after(box);
  }
  refreshButtons();
  refreshDefaults();
  probe();
});

tabsEl.addEventListener('input', function (event) {
  if (event.target.matches('.patterns')) {
    check(event.target.closest('.tab'));
  }
  refreshDefaults();
  probe();
});
probeEl.addEventListener('input', probe);

document.getElementById('add').addEventListener('click', function () {
  addTab({ label: '', patterns: [] }).querySelector('.label').focus();
});

document.getElementById('save').addEventListener('click', async function () {
  let bad = [...tabsEl.children].map(check).find(Boolean);
  if (bad) {
    flash('Invalid pattern: ' + bad, true);
    return;
  }
  await chrome.storage.sync.set({ config: read() });
  flash('Saved');
});

document.getElementById('reset').addEventListener('click', async function () {
  await chrome.storage.sync.remove('config');
  show(SIFT.DEFAULTS);
  probe();
  flash('Reset to defaults');
});

SIFT.load().then(show);

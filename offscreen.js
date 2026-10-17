// Tells background.js whether Chrome is in dark mode, now and whenever it changes.
let query = matchMedia('(prefers-color-scheme: dark)');

function report() {
  chrome.runtime.sendMessage({ type: 'sift:color-scheme', dark: query.matches });
}

query.addEventListener('change', report);
report();

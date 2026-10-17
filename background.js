// Chrome's manifest can't give the toolbar icon light and dark versions, and a service worker
// can't read the theme, so offscreen.js watches prefers-color-scheme and reports it here.
const ICONS = {
  dark: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
  light: { 16: 'icons/icon-light-16.png', 32: 'icons/icon-light-32.png' }
};

chrome.runtime.onMessage.addListener(function (message) {
  if (message?.type === 'sift:color-scheme') {
    chrome.action.setIcon({ path: message.dark ? ICONS.dark : ICONS.light });
  }
});

async function watchColorScheme() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      return;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['MATCH_MEDIA'],
      justification: 'Pick the toolbar icon that matches the light or dark theme.'
    });
  } catch (e) {
    // Already being created by another call (startup and install can overlap).
  }
}

chrome.runtime.onStartup.addListener(watchColorScheme);
chrome.runtime.onInstalled.addListener(watchColorScheme);
watchColorScheme();

chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage();
});

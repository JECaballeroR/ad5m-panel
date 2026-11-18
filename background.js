const FULL_URL = chrome.runtime.getURL('dashboard.html');

// Open the full-panel tab, or focus it if it already exists.
async function openFullTab() {
  try {
    const [ctx] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [FULL_URL] });
    if (ctx) {
      await chrome.tabs.update(ctx.tabId, { active: true });
      await chrome.windows.update(ctx.windowId, { focused: true });
      return;
    }
  } catch { /* fall back to a new tab */ }
  await chrome.tabs.create({ url: FULL_URL });
}

function setup() {
  // Clicking the icon opens the side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // Right-clicking the icon offers the full panel.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-full', title: 'Open full panel', contexts: ['action'] });
  });
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-full') openFullTab();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'open-full') openFullTab();
});

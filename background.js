// background.js — MV3 service worker
// 统计每天"切换/跳转到某个域名"的次数：
//  - 切换 tab        (chrome.tabs.onActivated，仅在 tab 已加载完时计数)
//  - 切换浏览器窗口   (chrome.windows.onFocusChanged)
//  - 在当前 tab 跳转 (chrome.tabs.onUpdated 的 status='complete' —— 等重定向链走完)
//  - Chrome 从别的 app 切回（同域名也算一次"又回来了"）

const DEFAULT_SETTINGS = {
  topN: 20,             // popup 默认展示前 N 名
  retentionDays: 30,    // 历史保留天数
};

// ---------- 工具函数 ----------
function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function getState() {
  const { byDay = {}, settings = {} } = await chrome.storage.local.get(['byDay', 'settings']);
  return {
    byDay,
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

// ---------- 计数核心 ----------
async function recordVisit(domain, title) {
  if (!domain) return;
  const day = todayKey();
  const { byDay, settings } = await getState();

  if (!byDay[day]) byDay[day] = {};
  const dayMap = byDay[day];

  if (!dayMap[domain]) {
    dayMap[domain] = { count: 0, firstVisit: Date.now(), lastVisit: 0, title: title || domain };
  }
  dayMap[domain].count += 1;
  dayMap[domain].lastVisit = Date.now();
  // 标题持续刷新（页面加载完后 tab.title 才是最终标题）
  if (title) dayMap[domain].title = title;

  // 清理超期数据
  const cutoffMs = Date.now() - settings.retentionDays * 86400 * 1000;
  for (const k of Object.keys(byDay)) {
    const ts = Date.parse(k);
    if (!Number.isNaN(ts) && ts < cutoffMs) delete byDay[k];
  }

  await setState({ byDay });
}

// ---------- 焦点跟踪 ----------
let lastFocusedDomain = null;
let chromeHasFocus = true;

async function getFocusedTab(windowId) {
  try {
    const opts = (windowId !== undefined && windowId !== chrome.windows.WINDOW_ID_NONE)
      ? { active: true, windowId }
      : { active: true, lastFocusedWindow: true };
    const tabs = await chrome.tabs.query(opts);
    return tabs[0] || null;
  } catch {
    return null;
  }
}

// 处理"焦点可能变化"的事件，决定是否计一次。
async function handleFocusEvent({ fromUnfocus = false, windowId } = {}) {
  const tab = await getFocusedTab(windowId);
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    // 当前焦点在 chrome:// / 新标签页等，不动 lastFocusedDomain
    return;
  }
  const domain = extractDomain(tab.url);
  if (!domain) return;

  const isDifferent = domain !== lastFocusedDomain;
  // 同域名 + 是从 Chrome 失焦回来 → 也算"又回来一次"
  if (fromUnfocus || isDifferent) {
    await recordVisit(domain, tab.title || '');
  }
  lastFocusedDomain = domain;
}

// 1) 切换 tab —— 只有当目标 tab 已经加载完，才立即计数；
//    否则等它的 status: 'complete' 再算（避免新开 tab 时同时被 onActivated 和 onUpdated 各记一次）
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;
    if (tab.status === 'loading') return;   // 加载完了 onUpdated 会兜底
    handleFocusEvent();
  } catch { /* tab 可能已关闭 */ }
});

// 2) 切换窗口 / Chrome 失去 / 重获焦点
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    chromeHasFocus = false;
    return;
  }
  const wasUnfocused = !chromeHasFocus;
  chromeHasFocus = true;
  await handleFocusEvent({ fromUnfocus: wasUnfocused, windowId });
});

// 3) 当前 tab 加载完成 —— 只在 status: 'complete' 时计数。
//    这样能合并重定向链 (A→mid→B)：中间域名不会被记一次，只有最终落地的 B 算 1 次。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.active) return;
  if (!tab.url || !/^https?:/.test(tab.url)) return;
  handleFocusEvent();
});

// 4) tab 关掉 → 清掉记忆，让下一次激活的 tab 一定算一次切换
chrome.tabs.onRemoved.addListener(() => {
  lastFocusedDomain = null;
});

// ---------- 与 popup 通信 ----------
async function getTopForDay(day, n) {
  const { byDay, settings } = await getState();
  const dayMap = byDay[day] || {};
  const items = Object.entries(dayMap).map(([domain, v]) => ({ domain, ...v }));
  items.sort((a, b) => b.count - a.count || b.lastVisit - a.lastVisit);
  return {
    day,
    items: items.slice(0, n ?? settings.topN),
    total: items.reduce((s, x) => s + x.count, 0),
    settings,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'GET_TOP_TODAY') {
        sendResponse(await getTopForDay(todayKey(), msg.n));
      } else if (msg?.type === 'GET_FULL_STATE') {
        sendResponse(await getState());
      } else if (msg?.type === 'GET_TOP_FOR_DAY') {
        sendResponse(await getTopForDay(msg.day, msg.n));
      } else if (msg?.type === 'UPDATE_SETTINGS') {
        const { settings } = await getState();
        const merged = { ...settings, ...(msg.patch || {}) };
        await setState({ settings: merged });
        sendResponse({ ok: true, settings: merged });
      } else if (msg?.type === 'CLEAR_TODAY') {
        const { byDay } = await getState();
        delete byDay[todayKey()];
        await setState({ byDay });
        sendResponse({ ok: true });
      } else if (msg?.type === 'CLEAR_ALL') {
        await setState({ byDay: {} });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown_message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // 异步响应
});

// ---------- 初始化 ----------
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await getState();
  await setState({ settings: { ...DEFAULT_SETTINGS, ...settings } });
  chrome.alarms.create('daily-cleanup', { periodInMinutes: 60 });
  const tab = await getFocusedTab();
  if (tab && tab.url && /^https?:/.test(tab.url)) {
    lastFocusedDomain = extractDomain(tab.url);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'daily-cleanup') {
    const { byDay, settings } = await getState();
    const cutoffMs = Date.now() - settings.retentionDays * 86400 * 1000;
    let changed = false;
    for (const k of Object.keys(byDay)) {
      const ts = Date.parse(k);
      if (!Number.isNaN(ts) && ts < cutoffMs) { delete byDay[k]; changed = true; }
    }
    if (changed) await setState({ byDay });
  }
});

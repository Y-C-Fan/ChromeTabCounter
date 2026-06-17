// background.js — MV3 service worker
// 统计每天每个域名被打开的次数，按 LFU 顺序排序提供给 popup。

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
async function recordVisit(url, title) {
  const domain = extractDomain(url);
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
  if (title) dayMap[domain].title = title;

  // 清理超期数据
  const cutoffMs = Date.now() - settings.retentionDays * 86400 * 1000;
  for (const k of Object.keys(byDay)) {
    const ts = Date.parse(k);
    if (!Number.isNaN(ts) && ts < cutoffMs) delete byDay[k];
  }

  await setState({ byDay });
}

// 防抖：同一 tab 在 1.2 秒内的多次 commit 算一次（避免框架重定向重复计数）
const lastCommitByTab = new Map(); // tabId -> { url, ts }

async function maybeCount(tabId, url) {
  const now = Date.now();
  const prev = lastCommitByTab.get(tabId);
  if (prev && prev.url === url && now - prev.ts < 1200) return;
  lastCommitByTab.set(tabId, { url, ts: now });

  let title = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab?.title || '';
  } catch { /* tab 可能已关 */ }
  await recordVisit(url, title);
}

// ---------- 事件监听 ----------
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;          // 只统计主框架
  if (!details.url) return;
  if (!/^https?:/.test(details.url)) return;
  maybeCount(details.tabId, details.url);
});

// 也覆盖 history.pushState/replaceState 这种 SPA 跳转
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!/^https?:/.test(details.url)) return;
  maybeCount(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => lastCommitByTab.delete(tabId));

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

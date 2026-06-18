// background.js — MV3 service worker
//
// 计数语义：每次"切换/跳转到一个不同域名"或"从失焦回来到同一个域名"算一次。
// 反双计数措施：
//   - status === 'complete' 才计（重定向链中间不计）
//   - 同一域名 COOLDOWN_MS 冷却内只计一次（防 SPA / 重复 complete / 抖动）
//   - lastFocusedDomain / chromeHasFocus / lastCountAt 持久化到 storage.session
//     这样即使 service worker 被回收重启，状态也不会丢
//   - onActivated 时 tab 还在 loading 就不计，等 onUpdated complete 兜底
//
// 调试：在 chrome://extensions → 本扩展 → "检查视图: service worker"
//      控制台能看到 [TFC] 前缀的日志（count / skip 原因 / 域名）

const DEFAULT_SETTINGS = {
  topN: 20,
  retentionDays: 30,
};

const SESSION_KEY = 'tfc_session_state';
const DEFAULT_SESSION = { lastFocusedDomain: null, chromeHasFocus: true, lastCountAt: {} };
// 同 domain 多次 +1 的最小间隔。可被测试通过 globalThis.__TFC_COOLDOWN_MS 覆盖。
const COOLDOWN_MS = (Number(globalThis.__TFC_COOLDOWN_MS) > 0)
  ? Number(globalThis.__TFC_COOLDOWN_MS)
  : 1500;

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

function pruneLastCountAt(map) {
  // 只保留最近 5 分钟的，防止无限增长
  const cutoff = Date.now() - 5 * 60 * 1000;
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (v >= cutoff) out[k] = v;
  }
  return out;
}

// ---------- 持久化数据 ----------
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

async function loadSession() {
  if (chrome.storage.session) {
    const r = await chrome.storage.session.get(SESSION_KEY);
    return { ...DEFAULT_SESSION, ...(r[SESSION_KEY] || {}) };
  }
  return { ...DEFAULT_SESSION };
}

async function saveSession(sess) {
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [SESSION_KEY]: sess });
  }
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
  if (title) dayMap[domain].title = title;

  const cutoffMs = Date.now() - settings.retentionDays * 86400 * 1000;
  for (const k of Object.keys(byDay)) {
    const ts = Date.parse(k);
    if (!Number.isNaN(ts) && ts < cutoffMs) delete byDay[k];
  }

  await setState({ byDay });
}

// ---------- 焦点跟踪 ----------
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

// 处理"焦点可能变化"的事件，决定是否计一次。reason 仅供日志使用。
async function handleFocusEvent({ fromUnfocus = false, windowId, reason = '' } = {}) {
  const tab = await getFocusedTab(windowId);
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    return;
  }
  const domain = extractDomain(tab.url);
  if (!domain) return;

  const sess = await loadSession();
  const isDifferent = domain !== sess.lastFocusedDomain;

  if (fromUnfocus || isDifferent) {
    const last = sess.lastCountAt?.[domain] || 0;
    const now = Date.now();
    const since = now - last;
    if (since < COOLDOWN_MS) {
      console.log(`[TFC] skip(${reason}) ${domain} (cooldown ${since}ms < ${COOLDOWN_MS}ms)`);
    } else {
      console.log(`[TFC] count(${reason}) ${domain} title="${(tab.title||'').slice(0,60)}"`);
      await recordVisit(domain, tab.title || '');
      sess.lastCountAt = pruneLastCountAt(sess.lastCountAt);
      sess.lastCountAt[domain] = now;
    }
  } else {
    // 同域名，且不是失焦回来 —— 不应计数（在同域名内点链接跳转的情况）
    // 只在 lastFocusedDomain 还没设置过时记录一下（debug）
    // 不打印日志，避免 SPA 频繁刷屏
  }
  sess.lastFocusedDomain = domain;
  await saveSession(sess);
}

// 1) 切换 tab —— 只有当目标 tab 已经加载完才立即计数；否则等 onUpdated complete 兜底
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;
    if (tab.status === 'loading') {
      console.log(`[TFC] defer(tab-switch) tab still loading, will count on complete`);
      return;
    }
    await handleFocusEvent({ reason: 'tab-switch' });
  } catch { /* tab 可能已关闭 */ }
});

// 2) 切换窗口 / Chrome 失去 / 重获焦点
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const sess = await loadSession();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    sess.chromeHasFocus = false;
    await saveSession(sess);
    console.log('[TFC] chrome lost focus');
    return;
  }
  const wasUnfocused = !sess.chromeHasFocus;
  sess.chromeHasFocus = true;
  await saveSession(sess);
  await handleFocusEvent({ fromUnfocus: wasUnfocused, windowId, reason: wasUnfocused ? 'window-refocus' : 'window-switch' });
});

// 3) 当前 tab 加载完成 —— 只在 status: 'complete' 时计数
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.active) return;
  if (!tab.url || !/^https?:/.test(tab.url)) return;
  handleFocusEvent({ reason: 'page-loaded' });
});

// 4) tab 关掉 → 让下一次激活的 tab 一定算一次切换
chrome.tabs.onRemoved.addListener(async () => {
  const sess = await loadSession();
  sess.lastFocusedDomain = null;
  await saveSession(sess);
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
  return true;
});

// ---------- 初始化 ----------
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await getState();
  await setState({ settings: { ...DEFAULT_SETTINGS, ...settings } });
  chrome.alarms.create('daily-cleanup', { periodInMinutes: 60 });
  const tab = await getFocusedTab();
  if (tab && tab.url && /^https?:/.test(tab.url)) {
    const sess = await loadSession();
    sess.lastFocusedDomain = extractDomain(tab.url);
    await saveSession(sess);
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

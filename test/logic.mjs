// test/logic.mjs
// mock chrome 的 tabs/windows 事件，验证"切换到域名"计数。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(path.resolve('background.js'), 'utf8');

function makeChromeMock() {
  const storage = { local: {} };
  const listeners = {
    tabs_onActivated: [],
    tabs_onUpdated: [],
    tabs_onRemoved: [],
    windows_onFocusChanged: [],
    runtime_onMessage: [],
    runtime_onInstalled: [],
    alarms_onAlarm: [],
  };

  // 模拟一组 tab 状态
  const tabsById = new Map();
  let activeTabId = null;
  let focusedWindowId = 1;

  return {
    listeners,
    tabsById,
    setActive(tabId) { activeTabId = tabId; },
    setFocusedWindow(id) { focusedWindowId = id; },
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) if (k in storage.local) out[k] = storage.local[k];
            return out;
          },
          set: async (obj) => Object.assign(storage.local, obj),
        },
      },
      tabs: {
        onActivated: { addListener: (cb) => listeners.tabs_onActivated.push(cb) },
        onUpdated: { addListener: (cb) => listeners.tabs_onUpdated.push(cb) },
        onRemoved: { addListener: (cb) => listeners.tabs_onRemoved.push(cb) },
        query: async (opts) => {
          // 测试中只用到 active+lastFocused / active+windowId
          const active = Array.from(tabsById.values()).filter(t => t.id === activeTabId);
          return active;
        },
        get: async (id) => tabsById.get(id) || null,
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener: (cb) => listeners.windows_onFocusChanged.push(cb) },
      },
      runtime: {
        onMessage: { addListener: (cb) => listeners.runtime_onMessage.push(cb) },
        onInstalled: { addListener: (cb) => listeners.runtime_onInstalled.push(cb) },
      },
      alarms: {
        create: () => {},
        onAlarm: { addListener: (cb) => listeners.alarms_onAlarm.push(cb) },
      },
    },
    storage,
  };
}

function callMessage(listeners, msg) {
  return new Promise((resolve) => {
    listeners.runtime_onMessage[0](msg, {}, (resp) => resolve(resp));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const ctx = makeChromeMock();
  const { chrome, listeners, tabsById } = ctx;

  const sandbox = { chrome, console, URL, Date, setTimeout, setInterval, Map };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });

  // 启动时没有任何 tab，onInstalled 跑一遍
  for (const cb of listeners.runtime_onInstalled) await cb();

  // 准备三个 tab
  tabsById.set(1, { id: 1, url: 'https://www.youtube.com/watch?v=a', title: 'YT', active: true, windowId: 1 });
  tabsById.set(2, { id: 2, url: 'https://www.google.com/search?q=x', title: 'G',  active: false, windowId: 1 });
  tabsById.set(3, { id: 3, url: 'https://github.com/explore',         title: 'GH', active: false, windowId: 1 });
  ctx.setActive(1);

  // ---- 场景 1：用户首次切到 youtube（onActivated） ----
  // 需要先把 lastFocusedDomain 重置（因为 onInstalled 里读不到 tab，已是 null）
  await listeners.tabs_onActivated[0]({ tabId: 1 });
  await sleep(20);

  // ---- 场景 2：在 youtube 内跳到下一个 youtube 视频（同域名，不计） ----
  tabsById.get(1).url = 'https://www.youtube.com/watch?v=b';
  await listeners.tabs_onUpdated[0](1, { url: tabsById.get(1).url }, tabsById.get(1));
  await sleep(20);

  // ---- 场景 3：切到 google ----
  tabsById.get(1).active = false; tabsById.get(2).active = true; ctx.setActive(2);
  await listeners.tabs_onActivated[0]({ tabId: 2 });
  await sleep(20);

  // ---- 场景 4：切回 youtube ----
  tabsById.get(2).active = false; tabsById.get(1).active = true; ctx.setActive(1);
  await listeners.tabs_onActivated[0]({ tabId: 1 });
  await sleep(20);

  // ---- 场景 5：再切到 google → github → google → youtube ----
  tabsById.get(1).active = false; tabsById.get(2).active = true; ctx.setActive(2);
  await listeners.tabs_onActivated[0]({ tabId: 2 });
  await sleep(20);
  tabsById.get(2).active = false; tabsById.get(3).active = true; ctx.setActive(3);
  await listeners.tabs_onActivated[0]({ tabId: 3 });
  await sleep(20);
  tabsById.get(3).active = false; tabsById.get(2).active = true; ctx.setActive(2);
  await listeners.tabs_onActivated[0]({ tabId: 2 });
  await sleep(20);
  tabsById.get(2).active = false; tabsById.get(1).active = true; ctx.setActive(1);
  await listeners.tabs_onActivated[0]({ tabId: 1 });
  await sleep(20);

  // ---- 场景 6：Chrome 失去焦点，再回到 youtube → 同域名也算"又回来一次" ----
  await listeners.windows_onFocusChanged[0](-1);            // WINDOW_ID_NONE
  await sleep(20);
  await listeners.windows_onFocusChanged[0](1);             // 回到 window 1（仍是 youtube tab）
  await sleep(20);

  // ---- 场景 7：地址栏从 youtube 跳到 google.com ----
  tabsById.get(1).url = 'https://www.google.com/foo';
  await listeners.tabs_onUpdated[0](1, { url: tabsById.get(1).url }, tabsById.get(1));
  await sleep(20);

  // ---- 场景 8：跳到 chrome:// 不算 ----
  tabsById.get(1).url = 'chrome://extensions/';
  await listeners.tabs_onUpdated[0](1, { url: tabsById.get(1).url }, tabsById.get(1));
  await sleep(20);

  await sleep(60);

  const top = await callMessage(listeners, { type: 'GET_TOP_TODAY', n: 10 });
  console.log('Top today:', JSON.stringify(top.items, null, 2));
  console.log('Total:', top.total);

  const map = Object.fromEntries(top.items.map(i => [i.domain, i.count]));
  // 计数推导：
  //  场景1: yt +1                     -> yt=1
  //  场景2: 同域名跳转, 不计           -> yt=1
  //  场景3: 切到 google +1             -> g=1
  //  场景4: 切回 yt +1                 -> yt=2
  //  场景5: g +1, gh +1, g +1, yt +1   -> yt=3, g=3, gh=1
  //  场景6: 失焦再回, 同域名 yt +1     -> yt=4
  //  场景7: 地址栏跳到 google.com +1   -> g=4
  //  场景8: chrome:// 不计              -> 不变
  assert.equal(map['youtube.com'], 4, `yt should be 4, got ${map['youtube.com']}`);
  assert.equal(map['google.com'], 4, `g should be 4, got ${map['google.com']}`);
  assert.equal(map['github.com'], 1, `gh should be 1, got ${map['github.com']}`);
  assert.equal(top.total, 9);
  // 排名靠前的应该是 yt 或 g（同 4 次）
  assert.ok(['youtube.com', 'google.com'].includes(top.items[0].domain));

  // settings: topN
  const upd = await callMessage(listeners, { type: 'UPDATE_SETTINGS', patch: { topN: 7 } });
  assert.equal(upd.settings.topN, 7);

  // CLEAR_TODAY
  await callMessage(listeners, { type: 'CLEAR_TODAY' });
  const after = await callMessage(listeners, { type: 'GET_TOP_TODAY' });
  assert.equal(after.items.length, 0);

  console.log('--- logic check passed ---');
}

run().catch(e => { console.error(e); process.exit(1); });

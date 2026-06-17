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

  const tabsById = new Map();
  let activeTabId = null;

  return {
    listeners,
    tabsById,
    setActive(tabId) { activeTabId = tabId; },
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
        query: async () => Array.from(tabsById.values()).filter(t => t.id === activeTabId),
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

// 模拟一次"完整加载"：tab 改成 loading，再变 complete，并触发 onUpdated
async function loadComplete(ctx, tabId, url, title) {
  const tab = ctx.tabsById.get(tabId);
  tab.url = url;
  tab.title = title;
  tab.status = 'complete';
  // 只发一次 status:'complete' 事件（模拟真实浏览器：重定向链中间不发 complete）
  await ctx.listeners.tabs_onUpdated[0](tabId, { status: 'complete' }, tab);
  await sleep(20);
}

async function run() {
  const ctx = makeChromeMock();
  const { chrome, listeners, tabsById } = ctx;

  const sandbox = { chrome, console, URL, Date, setTimeout, setInterval, Map };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });

  for (const cb of listeners.runtime_onInstalled) await cb();

  tabsById.set(1, { id: 1, url: 'https://www.youtube.com/watch?v=a', title: 'YouTube - 视频 A', active: true,  windowId: 1, status: 'complete' });
  tabsById.set(2, { id: 2, url: 'https://www.google.com/search?q=x', title: 'Google 搜索',       active: false, windowId: 1, status: 'complete' });
  tabsById.set(3, { id: 3, url: 'https://github.com/explore',         title: 'GitHub · 探索',    active: false, windowId: 1, status: 'complete' });
  ctx.setActive(1);

  // 场景 1: 首次切到 youtube
  await listeners.tabs_onActivated[0]({ tabId: 1 }); await sleep(20);

  // 场景 2: 在 youtube 内用一次 status:'complete' 跳到下一个 youtube 视频（同域名）
  await loadComplete(ctx, 1, 'https://www.youtube.com/watch?v=b', 'YouTube - 视频 B');

  // 场景 3: 切到 google
  tabsById.get(1).active = false; tabsById.get(2).active = true; ctx.setActive(2);
  await listeners.tabs_onActivated[0]({ tabId: 2 }); await sleep(20);

  // 场景 4: 切回 youtube
  tabsById.get(2).active = false; tabsById.get(1).active = true; ctx.setActive(1);
  await listeners.tabs_onActivated[0]({ tabId: 1 }); await sleep(20);

  // 场景 5: 重定向链 ── 在 google 里点了一个链接，最终落地是 zhihu.com。
  // 真实浏览器：中间的 t.zhihu.com 不会触发 status:'complete'，只有最终页会。
  // 我们的代码用 changeInfo.status === 'complete' 兜住，所以中间不会被记一次。
  tabsById.get(1).active = false; tabsById.get(2).active = true; ctx.setActive(2);
  await listeners.tabs_onActivated[0]({ tabId: 2 }); await sleep(20);   // google +1
  // 模拟在当前 tab 里跳转：先 loading（不发 complete），最后 complete 在 zhuanlan
  // 我们直接发 complete 一次到最终落地
  await loadComplete(ctx, 2, 'https://zhuanlan.zhihu.com/p/1', '知乎专栏文章');

  // 场景 6: Chrome 失焦后再回到当前 tab（zhihu），同域名也算"又回来"
  await listeners.windows_onFocusChanged[0](-1); await sleep(20);
  await listeners.windows_onFocusChanged[0](1);  await sleep(20);

  // 场景 7: 切到 chrome:// 不算（lastFocusedDomain 不变）
  tabsById.get(2).active = false;
  tabsById.set(99, { id: 99, url: 'chrome://extensions/', title: 'Extensions', active: true, windowId: 1, status: 'complete' });
  ctx.setActive(99);
  await listeners.tabs_onActivated[0]({ tabId: 99 }); await sleep(20);

  // 场景 8: 从 chrome:// 切回 zhihu，因为 lastFocusedDomain 还是 zhihu，所以不计
  tabsById.get(99).active = false; tabsById.get(2).active = true; ctx.setActive(2);
  await listeners.tabs_onActivated[0]({ tabId: 2 }); await sleep(20);

  // 场景 9: onActivated 时 tab 还在 loading，等 onUpdated 兜底
  tabsById.set(4, { id: 4, url: 'https://example.org/', title: '', active: false, windowId: 1, status: 'loading' });
  tabsById.get(2).active = false; tabsById.get(4).active = true; ctx.setActive(4);
  await listeners.tabs_onActivated[0]({ tabId: 4 }); await sleep(20);  // 不应计数（loading）
  // 现在 onUpdated 触发 complete
  await loadComplete(ctx, 4, 'https://example.org/welcome', '示例网站欢迎页');  // example.org +1

  await sleep(60);

  const top = await callMessage(listeners, { type: 'GET_TOP_TODAY', n: 20 });
  console.log('Top today:', JSON.stringify(top.items, null, 2));
  console.log('Total:', top.total);

  const map = Object.fromEntries(top.items.map(i => [i.domain, i]));
  // 计数推导：
  //  S1: yt +1                  -> yt=1
  //  S2: 同域名跳转 yt -> yt    -> yt=1（domain 没变，不计）
  //  S3: 切到 google +1         -> g=1
  //  S4: 切回 yt +1             -> yt=2
  //  S5: 切到 google +1         -> g=2; 然后地址栏跳到 zhihu +1 -> zhihu=1
  //  S6: 失焦回来同域名(zhihu) +1 -> zhihu=2
  //  S7: 切到 chrome://, 不计    -> 不变
  //  S8: 切回 zhihu, 但 lastFocusedDomain 还是 zhihu, 不计 -> 不变
  //  S9: 切到 loading tab 不计；onUpdated complete +1 -> example.org=1
  assert.equal(map['youtube.com']?.count, 2, `yt should be 2, got ${map['youtube.com']?.count}`);
  assert.equal(map['google.com']?.count, 2,  `g should be 2, got ${map['google.com']?.count}`);
  assert.equal(map['zhuanlan.zhihu.com']?.count, 2,   `zhihu should be 2, got ${map['zhuanlan.zhihu.com']?.count}`);
  assert.equal(map['example.org']?.count, 1, `example.org should be 1, got ${map['example.org']?.count}`);
  // 标题保留
  assert.equal(map['youtube.com']?.title, 'YouTube - 视频 B', 'should keep latest title');
  assert.equal(map['zhuanlan.zhihu.com']?.title, '知乎专栏文章', 'zhihu title should be Chinese');
  assert.equal(map['example.org']?.title, '示例网站欢迎页', 'example.org title should be Chinese');
  assert.equal(top.total, 7);

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

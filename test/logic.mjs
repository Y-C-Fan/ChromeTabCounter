// test/logic.mjs
// 给 background.js 注入一个 mock chrome 对象，模拟一天内多次导航事件，验证统计正确性。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(path.resolve('background.js'), 'utf8');

function makeChromeMock() {
  const storage = { local: {} };
  const listeners = {
    webNavigation_onCommitted: [],
    webNavigation_onHistory: [],
    tabs_onRemoved: [],
    runtime_onMessage: [],
    runtime_onInstalled: [],
    alarms_onAlarm: [],
  };
  return {
    listeners,
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
      webNavigation: {
        onCommitted: { addListener: (cb) => listeners.webNavigation_onCommitted.push(cb) },
        onHistoryStateUpdated: { addListener: (cb) => listeners.webNavigation_onHistory.push(cb) },
      },
      tabs: {
        onRemoved: { addListener: (cb) => listeners.tabs_onRemoved.push(cb) },
        get: async (tabId) => ({ id: tabId, title: 'mock-title-' + tabId }),
        query: async () => [],
        sendMessage: async () => {},
      },
      runtime: {
        onMessage: {
          addListener: (cb) => listeners.runtime_onMessage.push(cb),
        },
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
    const cb = listeners.runtime_onMessage[0];
    cb(msg, {}, (resp) => resolve(resp));
  });
}

async function run() {
  const { chrome, listeners, storage } = makeChromeMock();

  const sandbox = { chrome, console, URL, Date, setTimeout, setInterval, Map };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });

  for (const cb of listeners.runtime_onInstalled) await cb();

  const nav = listeners.webNavigation_onCommitted[0];

  // google 三次（防抖：紧挨着的同 url 算一次）
  nav({ frameId: 0, tabId: 1, url: 'https://www.google.com/search?q=a' });
  await sleep(20);
  nav({ frameId: 0, tabId: 1, url: 'https://www.google.com/search?q=b' });
  await sleep(20);
  nav({ frameId: 0, tabId: 1, url: 'https://www.google.com/search?q=c' });
  await sleep(20);
  nav({ frameId: 0, tabId: 1, url: 'https://www.google.com/search?q=c' });   // 防抖吞掉
  await sleep(20);

  // 子框架不算
  nav({ frameId: 1, tabId: 1, url: 'https://ad.example.com/x' });
  // chrome:// 不算
  nav({ frameId: 0, tabId: 2, url: 'chrome://extensions/' });
  // github 一次
  nav({ frameId: 0, tabId: 3, url: 'https://github.com/explore' });
  await sleep(20);

  // youtube 五次（含 SPA history 跳转）
  for (let i = 0; i < 3; i++) {
    nav({ frameId: 0, tabId: 4, url: 'https://www.youtube.com/watch?v=' + i });
    await sleep(20);
  }
  const histCb = listeners.webNavigation_onHistory[0];
  histCb({ frameId: 0, tabId: 4, url: 'https://www.youtube.com/feed/trending' });
  await sleep(20);
  histCb({ frameId: 0, tabId: 4, url: 'https://www.youtube.com/feed/subscriptions' });
  await sleep(20);

  await sleep(120);

  const top = await callMessage(listeners, { type: 'GET_TOP_TODAY', n: 10 });
  console.log('Top today:', JSON.stringify(top.items, null, 2));
  console.log('Total:', top.total);

  const map = Object.fromEntries(top.items.map(i => [i.domain, i.count]));
  assert.equal(map['google.com'], 3, 'google should have 3');
  assert.equal(map['github.com'], 1, 'github should have 1');
  assert.equal(map['youtube.com'], 5, 'youtube should have 5 (3 commits + 2 SPA)');
  assert.ok(!('ad.example.com' in map), 'iframe should not count');
  assert.equal(top.total, 9);
  assert.equal(top.items[0].domain, 'youtube.com', 'youtube should rank #1');

  // settings: topN
  const upd = await callMessage(listeners, { type: 'UPDATE_SETTINGS', patch: { topN: 7 } });
  assert.equal(upd.settings.topN, 7);

  // retentionDays 清理
  const old = '2020-01-01';
  storage.local.byDay[old] = { 'old.com': { count: 99, firstVisit: 0, lastVisit: 0, title: 'old' } };
  nav({ frameId: 0, tabId: 5, url: 'https://example.org/' });
  await sleep(60);
  assert.ok(!(old in storage.local.byDay), 'old day should be cleaned');

  // 清空今日
  await callMessage(listeners, { type: 'CLEAR_TODAY' });
  const after = await callMessage(listeners, { type: 'GET_TOP_TODAY' });
  assert.equal(after.items.length, 0);

  console.log('--- logic check passed ---');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
run().catch(e => { console.error(e); process.exit(1); });

// test/logic.mjs
// mock chrome 的 tabs/windows 事件，验证"切换到域名"计数。
// 重点覆盖：重定向链、SW 重启、B 站重复 complete、冷却节流、loading 抖动。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(path.resolve('background.js'), 'utf8');

function makeChromeMock() {
  const local = {};
  const session = {};
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
    listeners, tabsById, local, session,
    setActive(id) { activeTabId = id; },
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || local));
            for (const k of list) if (k in local) out[k] = local[k];
            return out;
          },
          set: async (obj) => Object.assign(local, obj),
        },
        session: {
          get: async (keys) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || session));
            for (const k of list) if (k in session) out[k] = session[k];
            return out;
          },
          set: async (obj) => Object.assign(session, obj),
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
  };
}

function callMessage(listeners, msg) {
  return new Promise((resolve) => {
    listeners.runtime_onMessage[0](msg, {}, (resp) => resolve(resp));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadSandbox(src, ctx) {
  const sandbox = {
    chrome: ctx.chrome,
    console,
    URL, Date, setTimeout, setInterval, Map,
    // 把测试用的冷却时间调短，便于断言
    __TFC_COOLDOWN_MS: 200,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });
  return sandbox;
}

async function run() {
  // ============ Pass 1: 主功能 ============
  let ctx = makeChromeMock();
  loadSandbox(src, ctx);
  for (const cb of ctx.listeners.runtime_onInstalled) await cb();

  ctx.tabsById.set(1, { id: 1, url: 'https://www.bilibili.com/video/BV1', title: '【测试】视频 A_哔哩哔哩', active: true,  windowId: 1, status: 'complete' });
  ctx.tabsById.set(2, { id: 2, url: 'https://www.google.com/',            title: 'Google',                  active: false, windowId: 1, status: 'complete' });
  ctx.setActive(1);

  // 场景 1: 切到 B 站
  await ctx.listeners.tabs_onActivated[0]({ tabId: 1 }); await sleep(20);
  // 场景 2: B 站连续抛 3 次 complete（视频流加载、播放器异步、SDK），应该只计 1 次
  for (let i = 0; i < 3; i++) {
    await ctx.listeners.tabs_onUpdated[0](1, { status: 'complete' }, ctx.tabsById.get(1));
    await sleep(30);
  }
  // 场景 3: 切到 google
  ctx.tabsById.get(1).active = false; ctx.tabsById.get(2).active = true; ctx.setActive(2);
  await ctx.listeners.tabs_onActivated[0]({ tabId: 2 }); await sleep(20);
  // 场景 4: 切回 B 站（用户描述的"我点完之后我再回来"）—— 等过冷却才能再 +1
  await sleep(220);
  ctx.tabsById.get(2).active = false; ctx.tabsById.get(1).active = true; ctx.setActive(1);
  await ctx.listeners.tabs_onActivated[0]({ tabId: 1 }); await sleep(20);
  // 场景 5: 再次回到 B 站后，B 站又抛了一次 complete（比如视频换集）—— 在冷却内，不应再计
  await ctx.listeners.tabs_onUpdated[0](1, { status: 'complete' }, ctx.tabsById.get(1));
  await sleep(30);

  await sleep(60);
  let top = await callMessage(ctx.listeners, { type: 'GET_TOP_TODAY', n: 10 });
  console.log('[Pass 1 result]', JSON.stringify(top.items.map(x=>({d:x.domain,c:x.count,t:x.title})),null,2));

  let map = Object.fromEntries(top.items.map(i => [i.domain, i.count]));
  assert.equal(map['bilibili.com'], 2, `B站应该是 2（首次切入 + 切回）, 实际 ${map['bilibili.com']}`);
  assert.equal(map['google.com'], 1, `google 应该是 1, 实际 ${map['google.com']}`);
  assert.equal(top.total, 3, `总数应该是 3, 实际 ${top.total}`);
  console.log('Pass 1 OK: 重复 complete + 切走再回 不会双计');

  // ============ Pass 2: 失焦再回 ============
  // Chrome 失去焦点（用户去 VS Code），再回 Chrome → 同域名也算"又回来一次"
  await ctx.listeners.windows_onFocusChanged[0](-1); await sleep(20);
  // 等过冷却
  await sleep(250);
  await ctx.listeners.windows_onFocusChanged[0](1); await sleep(20);
  await sleep(60);
  top = await callMessage(ctx.listeners, { type: 'GET_TOP_TODAY' });
  map = Object.fromEntries(top.items.map(i => [i.domain, i.count]));
  assert.equal(map['bilibili.com'], 3, `失焦回来后 B站应该是 3, 实际 ${map['bilibili.com']}`);
  console.log('Pass 2 OK: 失焦回到同域名 +1');

  // ============ Pass 3: 失焦快速回（冷却内）不计 ============
  await ctx.listeners.windows_onFocusChanged[0](-1); await sleep(20);
  await ctx.listeners.windows_onFocusChanged[0](1);  await sleep(20);   // 立刻回，应被冷却挡住
  await sleep(60);
  top = await callMessage(ctx.listeners, { type: 'GET_TOP_TODAY' });
  map = Object.fromEntries(top.items.map(i => [i.domain, i.count]));
  assert.equal(map['bilibili.com'], 3, `冷却内重复触发不应计数, 实际 ${map['bilibili.com']}`);
  console.log('Pass 3 OK: 冷却内重复触发被挡住');

  // ============ Pass 4: SW 重启场景 ============
  // 模拟 service worker 被回收：重新 load 一遍 background.js（local + session 数据保留）
  // 重启前再切到 google 让 lastFocusedDomain=google
  ctx.tabsById.get(1).active = false; ctx.tabsById.get(2).active = true; ctx.setActive(2);
  // 等过冷却（之前 google 是 200ms 前算的，加 sleep 250 即可）
  await sleep(260);
  await ctx.listeners.tabs_onActivated[0]({ tabId: 2 }); await sleep(30);
  let beforeRestart = (await callMessage(ctx.listeners, { type: 'GET_TOP_TODAY' }));
  let gBefore = beforeRestart.items.find(i=>i.domain==='google.com')?.count;
  console.log(`Before SW restart: google=${gBefore}`);

  // SW 重启：清掉所有事件 listener（模拟 worker 被回收），重新 load
  const oldLocal = ctx.local; const oldSession = ctx.session;
  const oldTabs = ctx.tabsById; const oldActive = 2;
  ctx = makeChromeMock();
  Object.assign(ctx.local, oldLocal);
  Object.assign(ctx.session, oldSession);
  for (const [k,v] of oldTabs) ctx.tabsById.set(k, v);
  ctx.setActive(oldActive);
  loadSandbox(src, ctx);
  // SW 重启时 onInstalled 不会再跑（只有真实安装/更新时才跑）
  console.log('[SW restarted]');

  // 重启后切回 B 站
  ctx.tabsById.get(2).active = false; ctx.tabsById.get(1).active = true; ctx.setActive(1);
  await ctx.listeners.tabs_onActivated[0]({ tabId: 1 }); await sleep(30);
  await sleep(60);
  top = await callMessage(ctx.listeners, { type: 'GET_TOP_TODAY' });
  map = Object.fromEntries(top.items.map(i => [i.domain, i.count]));
  // B 站之前是 3，现在切回 +1 = 4。重启不应该让计数翻倍或漏掉。
  assert.equal(map['bilibili.com'], 4, `SW 重启后切回 B站应该 +1 = 4, 实际 ${map['bilibili.com']}`);
  console.log('Pass 4 OK: SW 重启后状态保留 (lastFocusedDomain 持久化)');

  // ============ Pass 5: 重定向链不计中间 ============
  // 在 google 的 tab 里跳转：mock 实现 —— 中间页不会发 'complete'，只有最终落地页发
  // 切到 google
  ctx.tabsById.get(1).active = false; ctx.tabsById.get(2).active = true; ctx.setActive(2);
  await sleep(260); // 过冷却
  await ctx.listeners.tabs_onActivated[0]({ tabId: 2 }); await sleep(30);
  // 跳到 zhihu（重定向链：google → t.cn → zhuanlan.zhihu.com，只发最终 complete）
  ctx.tabsById.get(2).url = 'https://zhuanlan.zhihu.com/p/1';
  ctx.tabsById.get(2).title = '知乎专栏文章';
  await sleep(260); // 过冷却
  await ctx.listeners.tabs_onUpdated[0](2, { status: 'complete' }, ctx.tabsById.get(2));
  await sleep(60);
  top = await callMessage(ctx.listeners, { type: 'GET_TOP_TODAY' });
  map = Object.fromEntries(top.items.map(i => [i.domain, i.count]));
  assert.equal(map['zhuanlan.zhihu.com'], 1, `知乎应该是 1, 实际 ${map['zhuanlan.zhihu.com']}`);
  // 中间不应该出现 t.cn 之类
  for (const it of top.items) {
    assert.ok(!/^t\./.test(it.domain), `不应该统计中间跳转域名: ${it.domain}`);
  }
  console.log('Pass 5 OK: 重定向链只算最终落地页');

  // ============ Pass 6: 标题中文 ============
  const bili = top.items.find(i => i.domain === 'bilibili.com');
  assert.ok(bili.title.includes('哔哩哔哩'), `B站标题应包含中文: ${bili.title}`);
  console.log('Pass 6 OK: 中文标题保留');

  console.log('--- all logic checks passed ---');
}

run().catch(e => { console.error(e); process.exit(1); });

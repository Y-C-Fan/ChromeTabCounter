# Tab Frequency Counter

一个 Chrome / Edge 浏览器扩展（Manifest V3），用于：

- 📊 **统计你每天打开各个网页的次数**（按域名聚合）
- 🔝 **按 LFU（访问频率）把高频站点浮动到网页顶部条**
- 🪟 **通过插件图标 popup 看今日 TOP 排行**

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 自动计数 | 监听 `webNavigation.onCommitted` + `onHistoryStateUpdated`（覆盖 SPA 跳转），按域名聚合，主框架才算，1.2s 内同 URL 防抖 |
| 浮动条 | 每个 https 网页顶部注入一个 Shadow-DOM 隔离的浮动条，列出当天 TOP N 域名，带可点击芯片 + 收起/展开 |
| Popup 看板 | 点击工具栏图标查看今日详细排行（带条形图）、修改设置、清空数据 |
| 设置 | 浮动条开关 / TOP N / 至少几次才上榜 / 历史保留天数（默认 30 天，自动清理） |
| 隐私 | 全部数据使用 `chrome.storage.local`，不发送到任何服务器 |

## 文件结构

```
chrome-tab-counter/
├── manifest.json          # MV3 manifest
├── background.js          # service worker：统计/存储/广播
├── content.js             # 注入网页的浮动条
├── content.css            # 浮动条宿主样式
├── popup.html / .css / .js   # 工具栏 popup
├── icons/                 # 16/32/48/128 PNG
└── test/
    ├── syntax.mjs         # JSON + JS 语法校验
    └── logic.mjs          # 用 mock chrome 跑业务逻辑断言
```

## 安装（开发模式）

1. 打开 Chrome / Edge：`chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录 `D:\chrome-tab-counter`
4. 浏览几个网页 —— 顶部很快会出现 📊 高频条（默认要访问 ≥2 次的域名才上榜）

## 自测

```powershell
node test\syntax.mjs   # 语法/JSON 校验
node test\logic.mjs    # 业务逻辑（导航/防抖/SPA/排序/清理/设置）
```

## 版本

- v0.1.0 — 初版

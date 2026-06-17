# Tab Frequency Counter

一个 Chrome / Edge 浏览器扩展（Manifest V3）：

- 📊 **统计你每天"切换/跳转到"各个网页（域名）的次数**
- 🪟 **点击工具栏图标查看今日 TOP 排行**

不是统计"页面打开次数"，而是统计**"你又回到这个网页"的次数** —— 一直开着不算，切走再切回 +1。

---

## 计数规则

| 场景 | 是否 +1 |
| --- | --- |
| 切换浏览器 tab（域名变了） | ✅ |
| 在当前 tab 用地址栏跳到不同域名 | ✅ |
| 切到别的 app（VS Code、微信…），再切回 Chrome 同一页 | ✅ |
| 在同一个域名内点链接跳转（youtube → 下一个 youtube 视频） | ❌ |
| 一直开着不动 | ❌（永远只有最早那一次）|
| 跳到 `chrome://` / 新标签页 | ❌ |

数据按域名（去掉 `www.`）和日期聚合。

## 文件结构

```
chrome-tab-counter/
├── manifest.json
├── background.js          # service worker：监听 tab/window 焦点 + 计数
├── popup.html / .css / .js   # 工具栏 popup
├── icons/                 # 16/32/48/128 PNG
└── test/
    ├── syntax.mjs
    └── logic.mjs          # mock chrome API，覆盖 8 个切换场景
```

## 安装（开发模式）

1. 打开 Chrome / Edge：`chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录 `D:\chrome-tab-counter`
4. 来回切几个 tab —— 点右上角扩展图标 📊 看排行

## 自测

```powershell
node test\syntax.mjs
node test\logic.mjs
```

## 版本

- v0.3.0 — 计数语义改为"切换/跳转到域名"次数（switch-to-domain）
- v0.2.0 — 移除浮动条，所有展示集中到 popup
- v0.1.0 — 初版（含网页顶部浮动条）

// content.js — 在普通网页顶部注入一个浮动条，显示今日 TOP 高频站点。
(function () {
  if (window.top !== window) return;                 // 不在 iframe 中渲染
  if (document.documentElement.dataset.tfcInjected === '1') return;
  document.documentElement.dataset.tfcInjected = '1';

  const HOST_ID = 'tfc-floating-bar-host';

  function buildBar(items, settings) {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      // 用 Shadow DOM 隔离样式
      host.attachShadow({ mode: 'open' });
      (document.body || document.documentElement).appendChild(host);
    }
    const shadow = host.shadowRoot;

    const visible = settings.showBar && items.length > 0;
    if (!visible) {
      shadow.innerHTML = '';
      return;
    }

    const styles = `
      :host { all: initial; }
      .bar {
        position: fixed; top: 0; left: 0; right: 0;
        z-index: 2147483646;
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #fff;
        background: linear-gradient(90deg, rgba(20,20,30,.92), rgba(40,30,70,.92));
        backdrop-filter: blur(6px);
        box-shadow: 0 2px 6px rgba(0,0,0,.25);
        transform: translateY(0);
        transition: transform .25s ease;
      }
      .bar.collapsed { transform: translateY(-100%); }
      .label { opacity: .8; margin-right: 4px; white-space: nowrap; }
      .chips { display: flex; gap: 6px; flex: 1; overflow-x: auto; }
      .chip {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 3px 8px; border-radius: 999px;
        background: rgba(255,255,255,.12);
        white-space: nowrap; cursor: pointer;
        text-decoration: none; color: inherit;
      }
      .chip:hover { background: rgba(255,255,255,.22); }
      .chip.rank-0 { background: linear-gradient(90deg,#ff6a00,#ee0979); }
      .chip.rank-1 { background: linear-gradient(90deg,#f7971e,#ffd200); color:#222; }
      .chip.rank-2 { background: linear-gradient(90deg,#11998e,#38ef7d); color:#0a3d2a; }
      .count { font-weight: 700; }
      .toggle {
        margin-left: auto;
        background: transparent; border: 1px solid rgba(255,255,255,.4);
        color: #fff; border-radius: 4px;
        padding: 2px 8px; font-size: 11px; cursor: pointer;
      }
      .reopen {
        position: fixed; top: 6px; right: 6px;
        z-index: 2147483646;
        padding: 3px 8px; border-radius: 999px;
        background: rgba(20,20,30,.85); color:#fff; cursor: pointer;
        font: 11px -apple-system, sans-serif; border: 1px solid rgba(255,255,255,.2);
      }
    `;

    const collapsed = sessionStorage.getItem('tfc_collapsed') === '1';

    const chipsHtml = items.map((it, i) => {
      const cls = i < 3 ? `chip rank-${i}` : 'chip';
      const safeDomain = it.domain.replace(/[<>"']/g, '');
      return `<a class="${cls}" href="https://${encodeURIComponent(it.domain)}" title="${safeDomain} · ${it.count} 次">
                <span class="domain">${safeDomain}</span>
                <span class="count">×${it.count}</span>
              </a>`;
    }).join('');

    shadow.innerHTML = `
      <style>${styles}</style>
      ${collapsed
        ? `<div class="reopen" id="reopen">📊 高频站点</div>`
        : `<div class="bar" id="bar">
            <span class="label">📊 今日高频</span>
            <div class="chips">${chipsHtml}</div>
            <button class="toggle" id="toggle">收起</button>
          </div>`
      }
    `;

    if (collapsed) {
      shadow.getElementById('reopen').addEventListener('click', () => {
        sessionStorage.removeItem('tfc_collapsed');
        render();
      });
    } else {
      shadow.getElementById('toggle').addEventListener('click', () => {
        sessionStorage.setItem('tfc_collapsed', '1');
        render();
      });
    }
  }

  function render() {
    chrome.runtime.sendMessage({ type: 'GET_TOP_TODAY' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      const items = (resp.items || []).filter(x => x.count >= (resp.settings?.minCountForBar ?? 2));
      buildBar(items, resp.settings || { showBar: true });
    });
  }

  // 首次渲染
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'STATS_UPDATED') render();
  });
})();

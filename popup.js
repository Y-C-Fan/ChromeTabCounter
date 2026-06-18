// popup.js
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

async function refresh() {
  const resp = await send({ type: 'GET_TOP_TODAY', n: 100 });
  const ranks = document.getElementById('ranks');
  document.getElementById('today-label').textContent = resp.day;
  document.getElementById('total').textContent = resp.total ?? 0;

  if (!resp.items || resp.items.length === 0) {
    ranks.innerHTML = `<div class="empty">暂无数据，去访问几个网页就有了。</div>`;
  } else {
    const max = resp.items[0].count;
    const topN = resp.settings?.topN ?? 20;
    const shown = resp.items.slice(0, topN);
    ranks.innerHTML = shown.map((it, i) => {
      const pct = Math.round(it.count / max * 100);
      const rankCls = i < 3 ? `rank r${i}` : 'rank';
      const safeDomain = escapeHtml(it.domain);
      // 标题：优先用页面 title，没有就 fallback 到域名
      const rawTitle = (it.title && it.title.trim()) ? it.title.trim() : it.domain;
      const safeTitle = escapeHtml(rawTitle);
      const showSubdomain = rawTitle !== it.domain;   // 标题就是域名时不重复显示
      // it.domain 现在可能是带路径的 key（如 km.sankuai.com/collabpage/123），
      // 不能整体 encodeURIComponent（会把 / 编码掉），但要避免 javascript: 之类注入。
      const safeHref = /^[\w.-]+(?:\/[\w./-]*)?$/.test(it.domain)
        ? `https://${it.domain}`
        : '#';
      return `
        <div class="row-item">
          <div class="${rankCls}">${i + 1}</div>
          <div class="info">
            <div class="title" title="${safeTitle}">
              <a href="${safeHref}" target="_blank" rel="noopener">${safeTitle}</a>
            </div>
            ${showSubdomain ? `<div class="sub">${safeDomain}</div>` : ''}
            <div class="bar"><i style="width:${pct}%"></i></div>
          </div>
          <div class="count"><b>${it.count}</b> 次</div>
        </div>
      `;
    }).join('');
  }

  // 反映设置
  const s = resp.settings || {};
  document.getElementById('topN').value = s.topN ?? 20;
}

function bindSettings() {
  const topN = document.getElementById('topN');

  topN.addEventListener('change', async () => {
    await send({
      type: 'UPDATE_SETTINGS',
      patch: { topN: Math.max(1, Math.min(100, Number(topN.value) || 20)) },
    });
    refresh();
  });

  document.getElementById('clear-today').addEventListener('click', async () => {
    if (!confirm('清空今日的统计？')) return;
    await send({ type: 'CLEAR_TODAY' });
    refresh();
  });
  document.getElementById('clear-all').addEventListener('click', async () => {
    if (!confirm('清空所有历史数据？此操作不可撤销。')) return;
    await send({ type: 'CLEAR_ALL' });
    refresh();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindSettings();
  refresh();
});

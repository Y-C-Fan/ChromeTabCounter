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
      const safe = escapeHtml(it.domain);
      return `
        <div class="row-item">
          <div class="${rankCls}">${i + 1}</div>
          <div>
            <div class="domain"><a href="https://${encodeURIComponent(it.domain)}" target="_blank" rel="noopener">${safe}</a></div>
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

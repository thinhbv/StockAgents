/**
 * Dashboard realtime.
 *
 * Thứ tự nạp có ý nghĩa: lấy LỊCH SỬ trước qua /api/events?since=0, rồi mới
 * mở SSE từ id lớn nhất đã thấy. Nếu mở SSE trước, mọi sự kiện xảy ra giữa
 * hai lời gọi sẽ mất vĩnh viễn.
 */

const MAX_FEED_ITEMS = 200;
const SELECTED_KEY = 'agentboard.selected';

const $ = (id) => document.getElementById(id);
const state = { lastEventId: 0, selected: localStorage.getItem(SELECTED_KEY), navs: new Map() };

const vnd = (n) => (n === null || n === undefined) ? '—' : Math.round(n).toLocaleString('vi-VN');
const pct = (n) => (n === null || n === undefined) ? '—' : `${n > 0 ? '+' : ''}${n}%`;

// Nhãn tiếng Việt cho mọi mã trạng thái nội bộ — dùng CHUNG một bảng ở đây
// thay vì mỗi chỗ tự dịch một câu, để không bao giờ lệch nghĩa giữa "Phiên"
// ở đầu trang và dòng mô tả trong "Dòng sự kiện".
const DATA_STATE_LABEL = {
  DATA_READY: 'dữ liệu sẵn sàng', DATA_PARTIAL: 'dữ liệu thiếu một phần', DATA_STALE: 'dữ liệu cũ',
};
const SESSION_STATE_LABEL = {
  PRE_OPEN: 'chuẩn bị mở phiên', OPEN: 'mở cửa', WATCHING: 'đang theo dõi',
  CLOSING: 'đóng phiên', LEARNING: 'đang rút kinh nghiệm', IDLE: 'nghỉ',
};
const TRIGGER_LABEL = {
  TAKE_PROFIT: 'chốt lời', STOP_LOSS: 'cắt lỗ', TRAILING: 'trượt theo đỉnh',
  TIME_STOP: 'hết hạn giữ', NEWS_ALERT: 'tin xấu', EOD_REVIEW: 'rà soát cuối phiên',
  PRICE_MOVE: 'biến động mạnh',
};
const EVENT_TYPE_LABEL = {
  'session.state': 'trạng thái phiên', 'trigger.fired': 'chạm ngưỡng',
  'agent.started': 'đánh thức agent', 'agent.decided': 'agent quyết định',
  'agent.skipped': 'agent bỏ lượt', 'order.placed': 'đặt lệnh',
  'order.filled': 'khớp lệnh', 'order.rejected': 'lệnh bị từ chối',
  'position.marked': 'cập nhật vị thế', 'metrics.updated': 'cập nhật chỉ số',
  'market.snapshot': 'chỉ số thị trường', 'data.ingested': 'đã lấy dữ liệu giá',
  'data.stale': 'dữ liệu không dùng được',
};
const ACTION_LABEL = { BUY: 'MUA', SELL: 'BÁN', HOLD: 'GIỮ' };

function dirClass(n) {
  if (n === null || n === undefined || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}
function arrow(n) {
  if (n === null || n === undefined || n === 0) return '—';
  return n > 0 ? '▲' : '▼';
}

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function patchJson(path, payload) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${path}: HTTP ${res.status}`);
  return body;
}

async function postJson(path) {
  const res = await fetch(path, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${path}: HTTP ${res.status}`);
  return body;
}

/* ---------- Đầu bảng ---------- */

function setTag(el, text, kind) {
  el.textContent = text;
  el.className = `tag tag-${kind}`;
}

function tickClock() {
  const now = new Date().toLocaleTimeString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
  });
  $('clock').textContent = now;
}

async function refreshSession() {
  try {
    const s = await getJson('/api/session');
    const kind = { DATA_READY: 'ok', DATA_PARTIAL: 'warn', DATA_STALE: 'bad' }[s.state] ?? 'unknown';
    const label = DATA_STATE_LABEL[s.state] ?? (s.state === 'UNKNOWN' ? 'chưa chạy' : s.state);
    setTag($('session-state'), label, kind);

    if (!s.dataCapturedAt) {
      setTag($('data-freshness'), 'chưa có', s.state === 'UNKNOWN' ? 'unknown' : 'bad');
      return;
    }
    // ingest_prices chỉ chạy 1 lần/ngày (nến ngày mới chỉ có sau khi đóng
    // cửa) nên "cũ" vài trăm phút là bình thường — ngưỡng đỏ đặt ở 20 tiếng
    // để bắt đúng trường hợp thật sự hỏng: quên chạy/ingest lỗi từ hôm qua.
    const mins = Math.round((Date.now() - new Date(s.dataCapturedAt).getTime()) / 60000);
    const time = new Date(s.dataCapturedAt).toLocaleTimeString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false, hour: '2-digit', minute: '2-digit',
    });
    setTag($('data-freshness'), `tính lúc ${time}`, mins > 20 * 60 ? 'bad' : 'ok');
  } catch {
    setTag($('session-state'), 'mất kết nối', 'bad');
  }
}

/* ---------- Bảng xếp hạng ---------- */

function renderBoard(agents) {
  const body = $('board-body');

  if (agents.length === 0) {
    body.innerHTML = '<tr class="empty"><td colspan="7">Chưa có agent nào. '
      + 'Chạy <code>npm run sim:day</code> để bắt đầu.</td></tr>';
    return;
  }

  body.textContent = '';
  for (const a of agents) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.agent = a.id;
    tr.setAttribute('aria-selected', String(a.id === state.selected));

    const modelCell = a.isPending
      ? `${a.model} <span class="pending-tag" title="Đã sửa trên dashboard — áp dụng từ phiên chạy tiếp theo">`
        + `→ ${a.pendingModel}</span>`
      : a.model;

    tr.innerHTML = `
      <td class="col-agent"><span class="agent-name">${a.name}</span></td>
      <td class="col-model">${modelCell}</td>
      <td class="num" data-nav>${vnd(a.nav)}</td>
      <td class="num ${dirClass(a.totalReturnPct)}">${arrow(a.totalReturnPct)} ${pct(a.totalReturnPct)}</td>
      <td class="num ${dirClass(a.dayPnl)}">${a.dayPnl === null ? '—' : vnd(a.dayPnl)}</td>
      <td class="num">${vnd(a.cash)}</td>
      <td class="num">${a.positionCount}</td>`;

    // Nháy ô NAV khi đổi — như bảng giá thật báo có biến động.
    const prev = state.navs.get(a.id);
    if (prev !== undefined && a.nav !== null && a.nav !== prev) {
      const cell = tr.querySelector('[data-nav]');
      cell.classList.add(a.nav > prev ? 'flash-up' : 'flash-down');
    }
    if (a.nav !== null) state.navs.set(a.id, a.nav);

    const open = () => selectAgent(a.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    body.appendChild(tr);
  }
}

async function refreshBoard() {
  const { agents } = await getJson('/api/leaderboard');
  renderBoard(agents);
  if (state.selected && agents.some(a => a.id === state.selected)) {
    await refreshDetail(state.selected);
  }
}

/* ---------- Chi tiết agent ---------- */

function selectAgent(id) {
  state.selected = id;
  localStorage.setItem(SELECTED_KEY, id);
  for (const tr of document.querySelectorAll('#board-body tr')) {
    tr.setAttribute('aria-selected', String(tr.dataset.agent === id));
  }
  refreshDetail(id);
}

function renderPositions(list) {
  const box = $('positions');
  if (list.length === 0) {
    box.innerHTML = '<p class="persona">Không giữ mã nào.</p>';
    return;
  }

  box.textContent = '';
  for (const p of list) {
    const plan = p.exitPlan ?? {};
    const stop = Number.isFinite(plan.stopLossPct) ? plan.stopLossPct : -10;
    const take = Number.isFinite(plan.takeProfitPct) ? plan.takeProfitPct : 10;
    const now = p.unrealizedPct ?? 0;
    const at = Math.max(0, Math.min(100, ((now - stop) / (take - stop)) * 100));

    const el = document.createElement('div');
    el.className = 'position';
    el.innerHTML = `
      <div class="position-top">
        <span class="position-sym">${p.symbol}</span>
        <span class="figure ${dirClass(now)}">${arrow(now)} ${pct(now)}</span>
      </div>
      <p class="position-meta">${p.qtyTotal.toLocaleString('vi-VN')} cp
        · bán được ${p.qtySellable.toLocaleString('vi-VN')}
        · giá 1 cp ${vnd(p.avgCostVnd)}
        · tổng vốn ${vnd(p.avgCostVnd * p.qtyTotal)}</p>
      <div class="exit-bar">
        <span class="zone-loss"></span>
        <span class="zone-profit"></span>
        <span class="marker ${dirClass(now)}" style="left:${at}%"></span>
      </div>
      <div class="exit-legend">
        <span class="loss">cắt lỗ ${stop}%</span>
        <span class="profit">chốt lời +${take}%</span>
      </div>`;
    box.appendChild(el);
  }
}

/* ---------- Đường NAV ---------- */

const PLOT = { w: 720, h: 180, left: 60, right: 10, top: 12, bottom: 22 };

const shortDate = (iso) => (typeof iso === 'string' ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '');

/** Rút gọn tiền cho nhãn trục: 1_050_000_000 → "1,05 tỷ". */
function shortVnd(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2).replace('.', ',')} tỷ`;
  if (abs >= 1e6) return `${Math.round(n / 1e6)} tr`;
  return Math.round(n).toLocaleString('vi-VN');
}

function renderNavMetrics(m, latestNav, initialCapital) {
  const dl = $('nav-metrics');
  dl.textContent = '';

  const ret = (Number.isFinite(latestNav) && initialCapital > 0)
    ? Math.round(((latestNav - initialCapital) / initialCapital) * 10000) / 100
    : null;

  const rows = [
    ['Tổng tài sản', vnd(latestNav), ''],
    ['Lãi/lỗ', pct(ret), dirClass(ret)],
    // maxDrawdown lưu dạng % dương (mức sụt sâu nhất) — luôn là tin xấu nên
    // tô đỏ cố định, không dùng dirClass.
    ['Lỗ sâu nhất', m && m.maxDrawdown !== null ? `-${m.maxDrawdown}%` : '—', m?.maxDrawdown ? 'down' : ''],
    ['Tỷ lệ thắng', m && m.winRate !== null ? `${Math.round(m.winRate * 100)}%` : '—', ''],
    ['Sharpe', m && m.sharpe !== null ? m.sharpe : '—', ''],
    ['Số vòng', m ? m.tradeCount : '—', ''],
    // Dương: tự tin đúng lúc hơn lúc sai. Âm: càng tự tin càng dễ sai.
    ['Hiệu chuẩn tin cậy', m && m.confidenceCalibration !== null ? m.confidenceCalibration : '—',
      m && m.confidenceCalibration !== null ? dirClass(m.confidenceCalibration) : ''],
  ];

  for (const [label, value, cls] of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (cls) dd.className = cls;
    div.append(dt, dd);
    dl.appendChild(div);
  }
}

/**
 * Vẽ SVG nội tuyến — không thư viện, không phụ thuộc mạng.
 *
 * Trục Y luôn bao cả VỐN BAN ĐẦU chứ không chỉ min/max của NAV: nếu không,
 * một agent lỗ 3% và một agent lãi 3% sẽ cho hai biểu đồ trông giống hệt nhau,
 * và đường tham chiếu biến mất khỏi khung.
 */
function renderNavChart({ series, initialCapital, metrics }) {
  const box = $('nav-plot');
  const navs = series.map(p => p.nav).filter(Number.isFinite);
  const latest = navs.length ? navs[navs.length - 1] : null;

  renderNavMetrics(metrics, latest, initialCapital);

  if (navs.length === 0) {
    box.innerHTML = '<p class="empty-note">Chưa có phiên nào để vẽ. '
      + 'Chạy <code>npm run sim:day</code> rồi quay lại.</p>';
    return;
  }

  const { w, h, left, right, top, bottom } = PLOT;
  const innerW = w - left - right;
  const innerH = h - top - bottom;

  let lo = Math.min(initialCapital, ...navs);
  let hi = Math.max(initialCapital, ...navs);
  // Chuỗi hằng cho lo === hi; chia 0 sẽ ra NaN và SVG câm lặng không vẽ gì.
  if (hi === lo) { hi = lo * 1.01 || 1; lo = lo * 0.99 || 0; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;

  const x = (i) => left + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v) => top + (1 - (v - lo) / (hi - lo)) * innerH;

  const dir = dirClass(latest - initialCapital);
  const pts = series.map((p, i) => [x(i), y(p.nav)]);
  const line = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${(top + innerH).toFixed(1)} `
             + `L${pts[0][0].toFixed(1)},${(top + innerH).toFixed(1)} Z`;

  const baseY = y(initialCapital).toFixed(1);
  // NAV gần như không đổi thì baseY trùng vị trí nhãn hi/lo — hai chữ
  // "1,00 tỷ" chồng lên nhau, không đọc được. Đường nét đứt đã đủ đánh dấu
  // mốc vốn ban đầu, nên bỏ nhãn số khi nó đứng quá gần nhãn hi hoặc lo.
  const baseLabelHidden = Math.abs(baseY - (top + 4)) < 12 || Math.abs(baseY - (top + innerH)) < 12;
  // Chỉ ghi nhãn ngày ở vài mốc — 90 nhãn chồng lên nhau thì không đọc được.
  const step = Math.max(1, Math.ceil(series.length / 6));
  const ticks = series
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % step === 0 || i === series.length - 1)
    .map(({ p, i }) =>
      `<text class="nav-axis" x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${shortDate(p.snapDate)}</text>`);

  box.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" role="img"
         aria-label="Đường tổng tài sản ${series.length} phiên, hiện tại ${vnd(latest)} đồng">
      <text class="nav-axis" x="${left - 6}" y="${(top + 4).toFixed(1)}" text-anchor="end">${shortVnd(hi)}</text>
      <text class="nav-axis" x="${left - 6}" y="${(top + innerH).toFixed(1)}" text-anchor="end">${shortVnd(lo)}</text>
      ${baseLabelHidden ? '' : `<text class="nav-axis" x="${left - 6}" y="${baseY}" text-anchor="end">${shortVnd(initialCapital)}</text>`}
      <line class="nav-base" x1="${left}" y1="${baseY}" x2="${w - right}" y2="${baseY}"></line>
      <path class="nav-fill ${dir}" d="${area}"></path>
      <path class="nav-line ${dir}" d="${line}"></path>
      <circle class="nav-dot ${dir}" r="2.6"
              cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}"></circle>
      ${ticks.join('')}
    </svg>`;
}

function renderDecisions(list) {
  const ol = $('decisions');
  if (list.length === 0) {
    ol.innerHTML = '<p class="persona">Chưa có quyết định nào.</p>';
    return;
  }

  ol.textContent = '';
  for (const d of list) {
    const li = document.createElement('li');
    li.className = 'decision';
    const time = new Date(d.decidedAt).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
    });
    li.innerHTML = `
      <div class="decision-top">
        <span class="decision-act ${d.action}">${ACTION_LABEL[d.action] ?? d.action}</span>
        <span>${d.symbol}</span>
        <span>${d.qty.toLocaleString('vi-VN')} cp @ ${vnd(d.priceVnd)}</span>
        ${d.confidence === null ? '' : `<span>tin cậy ${d.confidence}</span>`}
        <span class="decision-time">${time}</span>
      </div>
      <p class="decision-reason">${d.reason}</p>`;
    ol.appendChild(li);
  }
}

async function refreshDetail(id) {
  try {
    const [agent, pos, dec, hist] = await Promise.all([
      getJson(`/api/agents/${encodeURIComponent(id)}`),
      getJson(`/api/agents/${encodeURIComponent(id)}/positions`),
      getJson(`/api/agents/${encodeURIComponent(id)}/decisions?limit=30`),
      getJson(`/api/agents/${encodeURIComponent(id)}/history?limit=90`),
    ]);
    $('detail').hidden = false;
    $('detail-persona').textContent = agent.personaPrompt;
    state.detailAgent = agent;
    closeConfigForm();
    await refreshDetailName(agent);
    renderNavChart(hist);
    renderPositions(pos.positions);
    renderDecisions(dec.decisions);
  } catch {
    $('detail').hidden = true;
  }
}

/* ---------- Sửa provider/model ---------- */

let catalog = null;

async function loadCatalog() {
  if (!catalog) catalog = await getJson('/api/config/catalog');
  return catalog;
}

/**
 * Tên hiển thị ở đầu panel: model ĐANG CHẠY THẬT (DB), kèm ghi chú "chờ áp
 * dụng: X" nếu config/agents.json đã có một lần sửa chưa qua phiên nào.
 * Không dùng agent.provider/model (đã có sẵn từ GET /api/agents/:id) để
 * hiện badge này vì nó chỉ phản ánh DB — phải gọi thêm endpoint /config để
 * biết có bản sửa nào đang chờ hay không.
 */
async function refreshDetailName(agent) {
  $('detail-name').textContent = `${agent.name} · ${agent.provider}/${agent.model}`;
  try {
    const cfg = await getJson(`/api/agents/${encodeURIComponent(agent.id)}/config`);
    state.detailConfig = cfg;
    if (cfg.isPending) {
      $('detail-name').textContent += ` (chờ áp dụng: ${cfg.pending.provider}/${cfg.pending.model})`;
    }
  } catch { /* không có cũng không sao — vẫn hiện được tên/model đang chạy */ }
}

function fillModelOptions() {
  const providerSel = $('config-provider');
  const modelSel = $('config-model');
  const models = catalog[providerSel.value] ?? [];
  modelSel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
}

function closeConfigForm() {
  $('config-form').hidden = true;
  $('config-edit-btn').hidden = false;
  $('config-status').textContent = '';
}

async function openConfigForm() {
  const agent = state.detailAgent;
  if (!agent) return;
  await loadCatalog().catch(() => {});
  if (!catalog) return;

  // Tô theo giá trị ĐANG CHỜ ÁP DỤNG (lần sửa gần nhất), không phải giá trị
  // đang chạy trong DB — nếu không, F5 xong sửa lại sẽ luôn thấy giá trị cũ.
  const pending = state.detailConfig?.pending ?? { provider: agent.provider, model: agent.model };

  const providerSel = $('config-provider');
  providerSel.innerHTML = Object.keys(catalog).map(p => `<option value="${p}">${p}</option>`).join('');
  providerSel.value = catalog[pending.provider] ? pending.provider : Object.keys(catalog)[0];
  fillModelOptions();
  if (catalog[providerSel.value]?.includes(pending.model)) $('config-model').value = pending.model;

  $('config-edit-btn').hidden = true;
  $('config-form').hidden = false;
  $('config-status').textContent = '';
}

async function submitConfigForm(e) {
  e.preventDefault();
  const agent = state.detailAgent;
  if (!agent) return;
  const provider = $('config-provider').value;
  const model = $('config-model').value;
  $('config-status').textContent = 'Đang lưu...';
  try {
    await patchJson(`/api/agents/${encodeURIComponent(agent.id)}/config`, { provider, model });
    $('config-status').textContent = 'Đã lưu — áp dụng từ phiên chạy tiếp theo.';
    await refreshDetailName(agent);
  } catch (err) {
    $('config-status').textContent = `Lỗi: ${err.message}`;
  }
}

/**
 * Reset agent đang chọn: xóa vị thế đang giữ, nạp lại vốn ban đầu. KHÔNG
 * xóa lịch sử đã giao dịch (trades/orders/lessons/NAV theo ngày...) — xem
 * routes.js::resetAgent. Xác nhận bằng confirm() vì đây là thao tác không
 * hoàn tác được từ phía người dùng.
 */
async function resetSelectedAgent() {
  const agent = state.detailAgent;
  if (!agent) return;
  const ok = confirm(
    `Reset "${agent.name}"?\n\nSẽ xóa TOÀN BỘ vị thế đang giữ và nạp lại vốn về 1.000.000.000đ.\n` +
    `Lịch sử đã giao dịch vẫn được giữ nguyên. Không thể hoàn tác.`);
  if (!ok) return;

  $('reset-status').textContent = 'Đang reset...';
  try {
    const r = await postJson(`/api/agents/${encodeURIComponent(agent.id)}/reset`);
    $('reset-status').textContent =
      `Đã xóa ${r.clearedPositions} vị thế, nạp lại ${vnd(r.cashVnd)}đ.`;
    await refreshBoard();
    await refreshDetail(agent.id);
  } catch (err) {
    $('reset-status').textContent = `Lỗi: ${err.message}`;
  }
}

/* ---------- Dòng sự kiện ---------- */

const TYPE_STYLE = {
  'trigger.fired': 't-trigger',
  'order.filled': 't-order',
  'order.rejected': 't-reject',
  'session.state': 't-session',
  'agent.skipped': 't-reject',
  'market.snapshot': 't-session',
};

function describe(e) {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'trigger.fired': return `${TRIGGER_LABEL[p.triggerType] ?? p.triggerType} · ${p.reason}`;
    case 'session.state': return `${SESSION_STATE_LABEL[p.state] ?? p.state}`
      + `${p.dataState ? ` · ${DATA_STATE_LABEL[p.dataState] ?? p.dataState}` : ''}`;
    case 'agent.started': return `đánh thức: ${(p.symbols ?? []).join(', ')}`;
    case 'agent.skipped': return `bỏ lượt — ${p.error}`;
    case 'metrics.updated': return `Tổng tài sản ${vnd(p.nav)} · ${pct(p.totalReturnPct)}`;
    case 'market.snapshot': return (p.indices ?? [])
      .map(i => `${i.indexCode} ${i.value} (${pct(i.changePct)})`)
      .join(' · ');
    case 'data.ingested': return `${p.succeeded}/${p.total} mã`;
    case 'data.stale': return `dữ liệu không dùng được — ${p.reason ?? p.job ?? ''}`;
    default: return JSON.stringify(p).slice(0, 120);
  }
}

function pushEvent(e) {
  const list = $('feed-list');
  const li = document.createElement('li');
  li.className = 'feed-item';

  // Chốt lời dùng màu trần (tím), cắt lỗ dùng màu sàn (xanh lơ) — cùng logic
  // "chạm biên" của bảng giá.
  let cls = TYPE_STYLE[e.type] ?? '';
  if (e.type === 'trigger.fired') {
    if (e.payload?.triggerType === 'TAKE_PROFIT') cls = 't-take';
    else if (e.payload?.triggerType === 'STOP_LOSS') cls = 't-stop';
  }

  const time = new Date(e.ts).toLocaleTimeString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
  });
  li.innerHTML = `
    <div class="feed-top">
      <span class="feed-time">${time}</span>
      <span class="feed-type ${cls}">${EVENT_TYPE_LABEL[e.type] ?? e.type}</span>
      ${e.agentId ? `<span class="feed-time">${e.agentId}</span>` : ''}
    </div>
    <p class="feed-body">${describe(e)}</p>`;

  list.prepend(li);
  while (list.children.length > MAX_FEED_ITEMS) list.lastElementChild.remove();

  if (e.id > state.lastEventId) state.lastEventId = e.id;
}

/* ---------- Luồng realtime ---------- */

function openStream() {
  const es = new EventSource(`/api/stream?since=${state.lastEventId}`);

  es.onopen = () => setTag($('stream-state'), 'trực tiếp', 'ok');
  es.onerror = () => setTag($('stream-state'), 'đang nối lại', 'warn');

  es.onmessage = (msg) => handle(msg);
  // Sự kiện có `event:` riêng không rơi vào onmessage, nên đăng ký từng loại.
  for (const type of [
    'session.state', 'agent.started', 'agent.decided', 'agent.skipped',
    'order.placed', 'order.filled', 'order.rejected',
    'trigger.fired', 'position.marked', 'metrics.updated', 'market.snapshot',
    'data.ingested', 'data.stale',
  ]) es.addEventListener(type, handle);

  function handle(msg) {
    let e;
    try { e = JSON.parse(msg.data); } catch { return; }
    pushEvent(e);
    // Sự kiện làm đổi số liệu thì làm mới bảng.
    if (['order.filled', 'metrics.updated', 'trigger.fired'].includes(e.type)) {
      refreshBoard().catch(() => {});
    }
    if (e.type === 'session.state') refreshSession().catch(() => {});
  }
}

/* ---------- Khởi động ---------- */

async function start() {
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => refreshSession().catch(() => {}), 60_000);

  $('config-edit-btn').addEventListener('click', () => openConfigForm().catch(() => {}));
  $('config-cancel-btn').addEventListener('click', closeConfigForm);
  $('config-form').addEventListener('submit', submitConfigForm);
  $('config-provider').addEventListener('change', fillModelOptions);
  $('reset-agent-btn').addEventListener('click', () => resetSelectedAgent().catch(() => {}));

  await refreshSession().catch(() => {});
  await refreshBoard().catch(() => {});

  // LỊCH SỬ TRƯỚC, rồi mới mở luồng từ con trỏ — không để hở khoảng nào.
  try {
    const { events } = await getJson('/api/events?since=0&limit=200');
    for (const e of events) pushEvent(e);
  } catch { /* trang vẫn dùng được nếu chưa có sự kiện nào */ }

  openStream();
}

start();

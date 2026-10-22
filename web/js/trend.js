// 全屏估值走势：今日 / 5日用分钟记录，1月及以上用历史净值按当前份额回溯。
// 可以只看合计，也可以每只基金一条线，再叠一条合计线。
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { api } from './api.js';
import { decFor, ticks, useWidth } from './charts.js';
import { hm, md, money, pct, tone, ymd } from './fmt.js';
import { Loading, Seg } from './ui.js';

const RANGES = [
  { value: '1d', label: '今日' },
  { value: '5d', label: '5日' },
  { value: '1m', label: '1月' },
  { value: '3m', label: '3月' },
  { value: '6m', label: '6月' },
  { value: '1y', label: '1年' },
];
const MODES = [
  { value: 'total', label: '合计' },
  { value: 'funds', label: '分基金' },
];
const UNITS = [
  { value: 'amt', label: '金额' },
  { value: 'pct', label: '涨跌幅' },
];
// 分类色只用 6 个（不用红绿，避免和涨跌混淆），多出来的基金并成「其他」
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
const MAX_LINES = COLORS.length;

const pref = {
  get: (k, d, ok) => {
    try {
      const v = localStorage.getItem('fl.trend.' + k);
      return ok.some((o) => o.value === v) ? v : d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem('fl.trend.' + k, v);
    } catch {
      /* 隐私模式忽略 */
    }
  },
};

function useTrendData(range, reloadKey) {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    setSt((s) => ({ ...s, loading: true, err: null }));
    const url = range === '1d' ? '/intraday' : range === '5d' ? '/intraday?days=5' : '/trend?range=' + range;
    const load = () =>
      api(url)
        .then((r) => alive && setSt({ loading: false, data: r, range }))
        .catch((e) => alive && setSt({ loading: false, err: e.message, range }));
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [range, reloadKey]);
  return st;
}

// 把一组持仓的「变化量」合成一条线：金额 = Σ变化；涨跌幅 = Σ变化 / Σ起点
function combine(parts, n, unit) {
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let d = 0;
    let b = 0;
    let any = false;
    for (const p of parts) {
      if (p.delta[i] == null) continue;
      d += p.delta[i];
      b += p.base;
      any = true;
    }
    if (any) out[i] = unit === 'pct' ? (b ? (d / b) * 100 : null) : d;
  }
  return out;
}

// 每只持仓得到 { delta: 每个点相对起点的变化（元）, base: 起点市值 }
function intradayParts(points, ids, range) {
  const parts = {};
  for (const id of ids) {
    let first = null;
    const delta = points.map((p) => {
      const v = p.hp?.[id];
      if (!v) return null;
      if (!first) first = v;
      // 今日：以开盘前的最新净值为基准（与首页小图一致）；多日：从区间起点算起
      const off = range === '1d' ? first[2] || 0 : 0;
      return v[1] - first[1] + off;
    });
    if (first) parts[id] = { delta, base: range === '1d' ? first[0] - (first[2] || 0) : first[0] };
  }
  return parts;
}

function dailyParts(data, ids) {
  const parts = {};
  for (const h of data.holdings || []) {
    if (!ids.includes(h.id)) continue;
    const base = h.values.find((v) => v != null);
    if (base == null) continue;
    parts[h.id] = { delta: h.values.map((v) => (v == null ? null : v - base)), base };
  }
  return parts;
}

function buildModel(st, members, unit, group, mode) {
  const { data, range } = st;
  const ids = members.map((m) => m.id);
  let xs;
  let parts;
  let note = '';
  if (range === '1d' || range === '5d') {
    const all = data.points || [];
    const pts = all.filter((p) => p.hp);
    // 分基金要用逐只的记录；只看合计时如果有升级前的旧记录，就用完整的组合合计（和首页小图一致）
    if (pts.length >= 2 && (mode === 'funds' || pts.length === all.length)) {
      xs = pts.map((p) => ({ t: p.t }));
      parts = intradayParts(pts, ids, range);
      if (pts.length < all.length) note = '更早的记录没有分基金数据，只显示升级之后的部分。';
    } else {
      // 升级前的旧记录只有组合合计
      const key = (p) => (group ? p.g?.[group.id] : [p.v, p.b]);
      const raw = all.filter(key);
      xs = raw.map((p) => ({ t: p.t }));
      if (!raw.length) return { xs: [], series: [], total: [], perFund: false };
      const b0 = range === '1d' ? key(raw[0])[1] : key(raw[0])[0];
      const total = raw.map((p) => (unit === 'pct' ? ((key(p)[0] - b0) / b0) * 100 : key(p)[0] - b0));
      return { xs, series: [], total, perFund: false,
        note: mode === 'funds' ? '这段时间只有组合合计的记录，分基金折线从现在开始记录。' : '' };
    }
  } else {
    xs = data.dates.map((d) => ({ d }));
    if (data.est) xs.push({ est: true });
    parts = dailyParts(data, ids);
    note = '1 月以上按每只基金当前的份额回溯计算（不含期间买卖），最后一个点是实时估算。';
  }
  const n = xs.length;
  const present = members.filter((m) => parts[m.id]);
  const shown = present.slice(0, present.length > MAX_LINES ? MAX_LINES - 1 : MAX_LINES);
  const rest = present.slice(shown.length);
  const series = shown.map((m, i) => ({ key: m.id, name: m.name, code: m.code, color: COLORS[i], values: combine([parts[m.id]], n, unit) }));
  if (rest.length) {
    series.push({ key: '_rest', name: `其他 ${rest.length} 只`, code: '', color: 'var(--ink-3)', dashed: true,
      values: combine(rest.map((m) => parts[m.id]), n, unit) });
  }
  const total = combine(present.map((m) => parts[m.id]), n, unit);
  return { xs, series, total, perFund: present.length > 0, note };
}

const fmt = (v, unit) => (unit === 'pct' ? pct(v) : money(v, { sign: true }));

function xLabel(x, kind) {
  if (x.est) return '实时';
  if (x.d) return md(x.d);
  return kind === '5d' ? `${md(ymd(new Date(x.t * 1000)))} ${hm(x.t)}` : hm(x.t);
}

function TrendChart({ model, unit, mode, hidden, kind, height }) {
  const [ref, w] = useWidth(900);
  const [hover, setHover] = useState(null);
  const { xs, total } = model;
  const lines = mode === 'funds' ? model.series.filter((s) => !hidden.has(s.key)) : [];
  const n = xs.length;
  if (n < 2) {
    return html`<div ref=${ref} class="trend-empty muted">
      ${kind === '1d' ? '今天还没有记录。交易时段内每分钟记录一次估值，开盘后这里就会画出来。' : '这个区间还没有足够的数据。'}
    </div>`;
  }
  const all = [0];
  for (const arr of [total, ...lines.map((l) => l.values)]) for (const v of arr) if (v != null) all.push(v);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;
  const L = 0, R = 76, T = 14, B = 30;
  const x = (i) => L + ((w - L - R) * i) / (n - 1);
  const y = (v) => T + (height - T - B) * (1 - (v - lo) / (hi - lo));
  const path = (vals) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const tk = ticks(lo, hi, 5);
  const dec = unit === 'pct' ? Math.max(1, decFor(tk.step)) : Math.max(0, decFor(tk.step));
  const tickText = (t) => (unit === 'pct' ? t.toFixed(dec) + '%' : money(t, { dec }));
  // 分钟数据：时间断开超过 20 分钟（午休、收盘到夜盘、隔日）的地方画虚线并标时间
  const breaks = [];
  const labels = [];
  if (xs[0].t) {
    labels.push(0);
    for (let i = 1; i < n; i++) {
      if (xs[i].t - xs[i - 1].t > 20 * 60) {
        breaks.push((x(i) + x(i - 1)) / 2);
        labels.push(i);
      }
    }
  } else {
    const k = Math.max(1, Math.round((n - 1) / 5));
    for (let i = 0; i < n - 1; i += k) labels.push(i);
  }
  if (labels[labels.length - 1] !== n - 1) labels.push(n - 1);
  // 标签太挤就跳过：从左往右挑，和上一个已显示的、以及最右端的标签都要留出距离
  const minGap = kind === '5d' ? 96 : 64;
  const shownLabels = [];
  for (const i of labels) {
    if (i === n - 1) continue;
    const prev = shownLabels[shownLabels.length - 1];
    if ((prev == null || x(i) - x(prev) >= minGap) && x(n - 1) - x(i) >= minGap) shownLabels.push(i);
  }
  shownLabels.push(n - 1);
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - x(0)) / (x(n - 1) - x(0))) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hv = hover;
  const tipRows = hv == null ? [] : lines.map((l) => ({ ...l, v: l.values[hv] })).filter((l) => l.v != null).sort((a, b) => b.v - a.v);
  const tipLeft = hv == null ? 0 : x(hv) > w * 0.6 ? Math.max(0, x(hv) - 250) : x(hv) + 14;
  return html`<div class="chart trend-chart" ref=${ref}>
    <svg width=${w} height=${height} onPointerMove=${move} onPointerDown=${move} onPointerLeave=${() => setHover(null)}>
      ${tk.out.map((t) => html`<line class="grid" x1=${L} x2=${w - R} y1=${y(t)} y2=${y(t)} />
        <text class="tick" x=${w - R + 10} y=${y(t) + 3.5}>${tickText(t)}</text>`)}
      <line class="zero" x1=${L} x2=${w - R} y1=${y(0)} y2=${y(0)} />
      ${breaks.map((b) => html`<line class="gap" x1=${b} x2=${b} y1=${T} y2=${height - B} />`)}
      ${lines.map((l) => html`<path class="tline" d=${path(l.values)} style=${{ stroke: l.color }} stroke-dasharray=${l.dashed ? '5 4' : null} />`)}
      <path class="tline total" d=${path(total)} />
      ${shownLabels.map((i) => html`<text class="tick" x=${x(i)} y=${height - 8}
          text-anchor=${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>${xLabel(xs[i], kind)}</text>`)}
      ${hv != null
        ? html`<line class="xh" x1=${x(hv)} x2=${x(hv)} y1=${T} y2=${height - B} />
          ${total[hv] != null ? html`<rect class="dot" x=${x(hv) - 4} y=${y(total[hv]) - 4} width="8" height="8" />` : null}`
        : null}
    </svg>
    ${hv != null
      ? html`<div class="tip trend-tip" style=${{ left: tipLeft + 'px', top: '8px' }}>
          <div class="tip-head">${xLabel(xs[hv], kind)}</div>
          <div class="tip-row strong"><span class="sw ink"></span><span class="tn">合计</span><span>${fmt(total[hv], unit)}</span></div>
          ${tipRows.map((l) => html`<div class="tip-row"><span class="sw" style=${{ background: l.color }}></span>
            <span class="tn">${l.name}</span><span>${fmt(l.v, unit)}</span></div>`)}
        </div>`
      : null}
  </div>`;
}

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

export function TrendView({ portfolio, group, onClose }) {
  const [range, setRange] = useState(() => pref.get('range', '1d', RANGES));
  const [mode, setMode] = useState(() => pref.get('mode', 'funds', MODES));
  const [unit, setUnit] = useState(() => pref.get('unit', 'amt', UNITS));
  const [hidden, setHidden] = useState(() => new Set());
  const st = useTrendData(range, portfolio?.now?.slice(0, 13));
  const close = useRef(onClose);
  close.current = onClose;
  const [vh, setVh] = useState(window.innerHeight);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close.current();
    const onResize = () => setVh(window.innerHeight);
    document.addEventListener('keydown', onKey);
    addEventListener('resize', onResize);
    document.body.classList.add('locked');
    return () => {
      document.removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      document.body.classList.remove('locked');
    };
  }, []);
  const set = (setter, k) => (v) => {
    setter(v);
    pref.set(k, v);
  };
  // 和首页一致：选了分组就只看这个分组；「全部」只看计入总资产的分组
  const inTotal = new Set((portfolio.groups || []).filter((g) => g.inTotal).map((g) => g.id));
  const members = (portfolio.holdings || [])
    .filter((h) => (group ? h.group === group.id : inTotal.has(h.group)))
    .map((h) => ({ id: h.id, name: h.name, code: h.code }));
  const model = useMemo(
    () => (st.data && st.range === range ? buildModel(st, members, unit, group, mode) : null),
    [st, unit, mode, members.map((m) => m.id).join(), group?.id],
  );
  const toggle = (key) => {
    const s = new Set(hidden);
    s.has(key) ? s.delete(key) : s.add(key);
    setHidden(s);
  };
  const narrow = window.innerWidth < 640;
  const chartH = Math.max(260, Math.min(narrow ? vh * 0.48 : vh - 330, 640));
  const totalLast = model ? last(model.total) : null;
  const firstX = model?.xs?.[0];
  const lastX = model?.xs?.[model.xs.length - 1];
  return html`<div class="fullview" role="dialog" aria-modal="true" aria-label="估值走势">
    <header class="fv-head">
      <div>
        <h3>估值走势<span class="fv-scope">${group ? group.name : '全部持仓'}</span></h3>
        ${model && totalLast != null
          ? html`<div class="fv-fig"><span class=${`num ${tone(totalLast)}`}>${fmt(totalLast, unit)}</span>
              <span class="muted small">${firstX ? xLabel(firstX, range) : ''} → ${lastX ? xLabel(lastX, range) : ''}</span></div>`
          : null}
      </div>
      <button class="icon-btn" onClick=${onClose} aria-label="关闭">×</button>
    </header>
    <div class="fv-body">
      <div class="fv-controls">
        <${Seg} small options=${RANGES} value=${range} onChange=${set(setRange, 'range')} label="时间范围" />
        <${Seg} small options=${MODES} value=${mode} onChange=${set(setMode, 'mode')} label="显示方式" />
        <${Seg} small options=${UNITS} value=${unit} onChange=${set(setUnit, 'unit')} label="单位" />
      </div>
      ${st.err ? html`<div class="callout warn">${st.err}</div>` : null}
      ${!model ? html`<div style=${{ height: chartH + 'px' }}><${Loading} text="读取走势" /></div>` : html`
        <${TrendChart} model=${model} unit=${unit} mode=${model.perFund ? mode : 'total'} hidden=${hidden} kind=${range} height=${chartH} />
        ${model.note ? html`<p class="field-hint">${model.note}</p>` : null}
        <div class="fv-legend">
          <div class="lg-row lg-total"><span class="sw ink"></span><span class="lg-name">合计</span>
            <span class=${`num ${tone(totalLast)}`}>${fmt(totalLast, unit)}</span></div>
          ${mode === 'funds' && model.perFund
            ? model.series.map((s) => {
                const v = last(s.values);
                return html`<button type="button" class=${`lg-row ${hidden.has(s.key) ? 'off' : ''}`} onClick=${() => toggle(s.key)}
                  aria-pressed=${!hidden.has(s.key)} title=${hidden.has(s.key) ? '点击显示' : '点击隐藏'}>
                  <span class=${`sw ${s.dashed ? 'dashed' : ''}`} style=${{ background: s.dashed ? 'none' : s.color, borderColor: s.color }}></span>
                  <span class="lg-name">${s.name}${s.code ? html` <span class="muted num">${s.code}</span>` : null}</span>
                  <span class=${`num ${tone(v)}`}>${fmt(v, unit)}</span>
                </button>`;
              })
            : null}
        </div>
        ${mode === 'funds' && model.perFund ? html`<p class="field-hint">点图例可以隐藏或显示某只基金；合计线始终是所有基金之和。</p>` : null}
      `}
    </div>
  </div>`;
}

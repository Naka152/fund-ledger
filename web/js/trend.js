// 全屏估值走势（行情软件样式）：今日 / 5日用分钟记录，1月及以上用历史净值按当前份额回溯。
// 合计：一条总市值折线；分基金：每只基金的市值一层层往上叠，最上沿就是合计。
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
  { value: 'funds', label: '分基金叠加' },
];
const UNITS = [
  { value: 'amt', label: '金额' },
  { value: 'pct', label: '涨跌幅' },
];
// 分类色只用 6 个（不用红绿，避免和涨跌混淆），多出来的基金并成「其他」
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
let uid = 0;

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

const sum = (arr) => arr.reduce((a, v) => a + (v || 0), 0);

// 把基金列表折成最多 6 层：前 5 只各一层，其余合成「其他」
function foldBands(members, valuesOf, n) {
  const present = members.map((m) => ({ ...m, values: valuesOf(m.id) })).filter((m) => m.values);
  const keep = present.length > COLORS.length ? present.slice(0, COLORS.length - 1) : present;
  const rest = present.slice(keep.length);
  const bands = keep.map((m, i) => ({ key: m.id, name: m.name, code: m.code, color: COLORS[i], values: m.values }));
  if (rest.length) {
    bands.push({
      key: '_rest', name: `其他 ${rest.length} 只`, code: '', color: 'var(--ink-3)',
      values: Array.from({ length: n }, (_, i) => sum(rest.map((m) => m.values[i]))),
    });
  }
  return bands;
}

/**
 * 统一成：xs（时间或日期）、total（合计市值）、base（基准线：今日为最新净值对应的市值，其余为区间起点）、
 * bands（分基金市值，可能为空）。涨跌幅模式下 total/base 换算成相对基准的百分比。
 */
function buildModel(st, members, unit, group, mode) {
  const { data, range } = st;
  const ids = members.map((m) => m.id);
  let xs;
  let total;
  let base;
  let bands = null;
  let note = '';
  if (range === '1d' || range === '5d') {
    const all = data.points || [];
    const hpPts = all.filter((p) => p.hp && ids.some((id) => p.hp[id]));
    if (hpPts.length >= 2 && (mode === 'funds' || hpPts.length === all.length)) {
      xs = hpPts.map((p) => ({ t: p.t }));
      bands = foldBands(members, (id) => (hpPts.some((p) => p.hp[id]) ? hpPts.map((p) => p.hp[id]?.[0] ?? null) : null), xs.length);
      total = hpPts.map((p) => sum(ids.map((id) => p.hp[id]?.[0])));
      const p0 = hpPts[0];
      base = range === '1d' ? sum(ids.map((id) => (p0.hp[id] ? p0.hp[id][0] - (p0.hp[id][2] || 0) : 0))) : total[0];
      if (hpPts.length < all.length) note = '更早的记录没有分基金数据，只显示升级之后的部分。';
    } else {
      // 升级前的旧记录只有组合合计
      const key = (p) => (group ? p.g?.[group.id] : p.v != null ? [p.v, p.b] : null);
      const pts = all.filter(key);
      xs = pts.map((p) => ({ t: p.t }));
      total = pts.map((p) => key(p)[0]);
      base = pts.length ? (range === '1d' ? key(pts[0])[1] : total[0]) : null;
      if (mode === 'funds') note = '这段时间只有组合合计的记录，分基金叠加从现在开始记录。';
    }
  } else {
    xs = data.dates.map((d) => ({ d }));
    if (data.est) xs.push({ est: true });
    const byId = Object.fromEntries((data.holdings || []).map((h) => [h.id, h.values]));
    // 区间里还没有净值的日子按第一个净值补平，免得合计在基金成立那天跳一下
    const filled = (id) => {
      const v = byId[id];
      if (!v) return null;
      const first = v.find((x) => x != null);
      return first == null ? null : v.map((x) => (x == null ? first : x));
    };
    bands = foldBands(members, filled, xs.length);
    total = xs.map((_, i) => sum(ids.map((id) => filled(id)?.[i])));
    base = total[0];
    note = '1 月以上按每只基金当前的份额回溯计算（不含期间买卖），最后一个点是实时估算。';
  }
  if (unit === 'pct' && base) {
    total = total.map((v) => (v / base - 1) * 100);
    base = 0;
  }
  return { xs, total, base, bands: bands && bands.length ? bands : null, note, range };
}

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

const CN_WD = '日一二三四五六';

function xLabel(x, kind, long = false) {
  if (x.est) return '实时';
  if (x.d) return long ? `${x.d} 周${CN_WD[new Date(x.d + 'T00:00:00+08:00').getUTCDay()]}` : md(x.d);
  const d = ymd(new Date(x.t * 1000));
  return long || kind === '5d' ? `${md(d)} ${hm(x.t)}` : hm(x.t);
}

// 时间轴刻度：分钟数据在整点、开盘和跨日处标注（跨日加粗「22日」）；日线在月初加粗「10月」，其余标日期
function timeTicks(xs) {
  const out = [];
  const multiDay = xs[0]?.t && ymd(new Date(xs[0].t * 1000)) !== ymd(new Date((last(xs.map((x) => x.t)) ?? xs[0].t) * 1000));
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const p = xs[i - 1];
    if (x.est) {
      out.push({ i, text: '实时', pri: 1 });
    } else if (x.t) {
      const d = ymd(new Date(x.t * 1000));
      const pd = p && ymd(new Date(p.t * 1000));
      const h = hm(x.t);
      if (!p) out.push(multiDay ? { i, text: `${+d.slice(8)}日`, strong: true, pri: 3 } : { i, text: h, pri: 2 });
      else if (d !== pd) out.push({ i, text: `${+d.slice(8)}日`, strong: true, pri: 3 });
      else if (x.t - p.t > 20 * 60) out.push({ i, text: h, pri: 2 });
      else if (h.slice(0, 2) !== hm(p.t).slice(0, 2)) out.push({ i, text: h.slice(0, 2) + ':00', pri: 1 });
    } else if (!p) {
      out.push({ i, text: md(x.d), pri: 2 });
    } else if (x.d.slice(0, 4) !== p.d?.slice(0, 4)) {
      out.push({ i, text: x.d.slice(0, 4), strong: true, pri: 4 });
    } else if (x.d.slice(5, 7) !== p.d?.slice(5, 7)) {
      out.push({ i, text: `${+x.d.slice(5, 7)}月`, strong: true, pri: 3 });
    } else {
      out.push({ i, text: String(+x.d.slice(8)), pri: 0 });
    }
  }
  return out;
}

function TrendChart({ model, unit, stacked, kind, height }) {
  const [ref, w] = useWidth(900);
  const [hover, setHover] = useState(null);
  const [gid] = useState(() => 'tg' + ++uid);
  const { xs, total, base } = model;
  const n = xs.length;
  if (n < 2) {
    return html`<div ref=${ref} class="trend-empty muted">
      ${kind === '1d' ? '今天还没有记录。交易时段内每分钟记录一次估值，开盘后这里就会画出来。' : '这个区间还没有足够的数据。'}
    </div>`;
  }
  const bands = stacked ? model.bands : null;
  // 叠加：逐层累加；最上面一层的上沿就是合计
  const cum = [];
  if (bands) {
    let acc = new Array(n).fill(0);
    for (const b of bands) {
      acc = acc.map((a, i) => a + (b.values[i] || 0));
      cum.push(acc);
    }
  }
  const top = bands ? cum[cum.length - 1] : total;
  const vals = top.filter((v) => v != null);
  let lo;
  let hi;
  if (bands) {
    lo = 0; // 叠加图从 0 开始，每一层的厚度才是真实的市值
    hi = Math.max(...vals) * 1.06;
  } else {
    lo = Math.min(...vals, base ?? Infinity);
    hi = Math.max(...vals, base ?? -Infinity);
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.002 || 1;
    lo -= pad;
    hi += pad;
  }
  const R = 92, T = 30, B = 26; // 顶部留一行给左上角的数值说明
  const plotW = w - R;
  const x = (i) => (plotW * i) / (n - 1);
  const y = (v) => T + (height - T - B) * (1 - (v - lo) / (hi - lo));
  const linePath = (arr) => {
    let d = '';
    let pen = false;
    arr.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const bandPath = (upper, lower) => {
    let d = upper.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    for (let i = n - 1; i >= 0; i--) d += `L${x(i).toFixed(1)},${y(lower ? lower[i] : 0).toFixed(1)}`;
    return d + 'Z';
  };
  const lastV = last(total);
  const lastTop = last(top);
  const up = base != null && lastV != null ? lastV >= base : true;
  const lineColor = up ? 'var(--up)' : 'var(--down)';
  const tk = ticks(lo, hi, Math.max(3, Math.round(height / 70)));
  const dec = unit === 'pct' ? Math.max(1, decFor(tk.step)) : Math.min(2, Math.max(0, decFor(tk.step)));
  const axisText = (v, d = dec) => (unit === 'pct' ? pct(v, d) : money(v, { dec: d }));
  // 时间轴：按优先级挑不重叠的刻度
  const cand = timeTicks(xs).sort((a, b) => b.pri - a.pri || a.i - b.i);
  // 挤掉的月份 / 跨日刻度仍占着位置，免得旁边冒出一个孤零零的日期
  const chosen = [];
  const held = [];
  for (const c of cand) {
    if ([...chosen, ...held.filter((o) => o.pri > c.pri)].every((o) => Math.abs(x(o.i) - x(c.i)) >= 58)) chosen.push(c);
    else if (c.pri >= 3) held.push(c);
  }
  chosen.sort((a, b) => a.i - b.i);
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hv = hover;
  const hvTop = hv != null ? top[hv] : null;
  // 右侧标签：现值（红/绿底）与基准线（灰底），两者太近时把基准线标签挪开
  const yLast = y(lastTop);
  let yBase = base != null && !bands ? y(base) : null;
  if (yBase != null && Math.abs(yBase - yLast) < 20) yBase = yLast + (yBase >= yLast ? 20 : -20);
  const baseLabel = model.range === '1d' ? '最新净值' : '区间起点';
  const tipRows = hv != null && bands
    ? [...bands].reverse().map((b) => ({ ...b, v: b.values[hv] })).filter((b) => b.v != null)
    : [];
  const tipLeft = hv == null ? 0 : x(hv) > plotW * 0.6 ? Math.max(0, x(hv) - 268) : x(hv) + 16;
  const timeBoxX = hv == null ? 0 : Math.min(Math.max(0, x(hv) - 62), plotW - 124);
  return html`<div class="chart tv-chart" ref=${ref}>
    <svg width=${w} height=${height} onPointerMove=${move} onPointerDown=${move} onPointerLeave=${() => setHover(null)}>
      <defs>
        <linearGradient id=${gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style=${{ stopColor: lineColor, stopOpacity: 0.32 }} />
          <stop offset="1" style=${{ stopColor: lineColor, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      ${tk.out.map((t) => html`<text class="tv-axis" x=${plotW + 10} y=${y(t) + 4}>${axisText(t)}</text>`)}
      ${bands
        ? bands.map((b, k) => html`<path class="tv-band" d=${bandPath(cum[k], k ? cum[k - 1] : null)} style=${{ fill: b.color }} />
            <path class="tv-band-edge" d=${linePath(cum[k])} style=${{ stroke: b.color }} />`)
        : html`<path d=${`${linePath(total)}L${x(n - 1)},${height - B}L0,${height - B}Z`} fill=${`url(#${gid})`} />`}
      ${base != null && !bands ? html`<line class="tv-base" x1="0" x2=${plotW} y1=${y(base)} y2=${y(base)} />` : null}
      <path class="tv-line" d=${linePath(top)} style=${{ stroke: bands ? 'var(--ink)' : lineColor }} />
      ${chosen.map((c) => html`<text class=${`tv-time ${c.strong ? 'strong' : ''}`} x=${x(c.i)} y=${height - 7}
          text-anchor=${c.i === 0 ? 'start' : c.i === n - 1 ? 'end' : 'middle'}>${c.text}</text>`)}
      ${yBase != null
        ? html`<g class="tv-tag base"><rect x=${plotW - 64} y=${yBase - 10} width="62" height="20" />
            <text x=${plotW - 33} y=${yBase + 4} text-anchor="middle">${baseLabel}</text>
            <rect x=${plotW + 2} y=${yBase - 10} width=${R - 4} height="20" />
            <text x=${plotW + R / 2} y=${yBase + 4} text-anchor="middle">${axisText(base, 2)}</text></g>`
        : null}
      <g class=${`tv-tag now ${bands ? 'ink' : ''}`} style=${{ '--tag': bands ? 'var(--ink)' : lineColor }}>
        <rect x=${plotW + 2} y=${yLast - 10} width=${R - 4} height="20" />
        <text x=${plotW + R / 2} y=${yLast + 4} text-anchor="middle">${axisText(lastTop, 2)}</text>
      </g>
      ${hv != null && hvTop != null
        ? html`<g class="tv-cross">
            <line x1=${x(hv)} x2=${x(hv)} y1=${T} y2=${height - B} />
            <line x1="0" x2=${plotW} y1=${y(hvTop)} y2=${y(hvTop)} />
          </g>
          <g class="tv-tag cross">
            <rect x=${plotW + 2} y=${y(hvTop) - 10} width=${R - 4} height="20" />
            <text x=${plotW + R / 2} y=${y(hvTop) + 4} text-anchor="middle">${axisText(hvTop, 2)}</text>
            <rect x=${timeBoxX} y=${height - B + 3} width="124" height="20" />
            <text x=${timeBoxX + 62} y=${height - B + 17} text-anchor="middle">${xLabel(xs[hv], kind, true)}</text>
          </g>`
        : null}
    </svg>
    <div class="tv-info">
      <span class="muted">${xLabel(xs[hv ?? n - 1], kind, true)}</span>
      <span class="num">${axisText(hv != null ? hvTop : lastTop, 2)}</span>
      ${base != null && !bands
        ? (() => {
            const v = hv != null ? total[hv] : lastV;
            const dv = v - base;
            return unit === 'pct'
              ? html`<span class=${`num ${tone(dv)}`}>${pct(dv)}</span>`
              : html`<span class=${`num ${tone(dv)}`}>${money(dv, { sign: true })}（${pct(base ? (dv / base) * 100 : null)}）</span>`;
          })()
        : null}
    </div>
    ${tipRows.length
      ? html`<div class="tip trend-tip" style=${{ left: tipLeft + 'px', top: '34px' }}>
          <div class="tip-row strong"><span class="sw ink"></span><span class="tn">合计</span><span>${money(hvTop)}</span></div>
          ${tipRows.map((b) => html`<div class="tip-row"><span class="sw" style=${{ background: b.color }}></span>
            <span class="tn">${b.name}</span><span>${money(b.v)}</span></div>`)}
        </div>`
      : null}
  </div>`;
}

export function TrendView({ portfolio, group, onClose }) {
  const [range, setRange] = useState(() => pref.get('range', '1d', RANGES));
  const [mode, setMode] = useState(() => pref.get('mode2', 'total', MODES));
  const [unit, setUnit] = useState(() => pref.get('unit', 'amt', UNITS));
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
  const stacked = mode === 'funds';
  const effUnit = stacked ? 'amt' : unit; // 叠加只有按金额才有意义
  // 和首页一致：选了分组就只看这个分组；「全部」只看计入总资产的分组
  const inTotal = new Set((portfolio.groups || []).filter((g) => g.inTotal).map((g) => g.id));
  const members = (portfolio.holdings || [])
    .filter((h) => (group ? h.group === group.id : inTotal.has(h.group)))
    .map((h) => ({ id: h.id, name: h.name, code: h.code }));
  const model = useMemo(
    () => (st.data && st.range === range ? buildModel(st, members, effUnit, group, mode) : null),
    [st, effUnit, mode, members.map((m) => m.id).join(), group?.id],
  );
  const narrow = window.innerWidth < 640;
  const chartH = Math.max(280, Math.min(narrow ? vh * 0.5 : vh - 300, 660));
  const showBands = stacked && model?.bands;
  const lastV = model ? last(model.total) : null;
  const dv = model && model.base != null && lastV != null ? lastV - model.base : null;
  return html`<div class="fullview" role="dialog" aria-modal="true" aria-label="估值走势">
    <header class="fv-head">
      <div>
        <h3>估值走势<span class="fv-scope">${group ? group.name : '全部持仓'}</span></h3>
        ${model && lastV != null
          ? html`<div class="fv-fig"><span class="num">${effUnit === 'pct' ? pct(lastV) : money(lastV)}</span>
              ${dv != null && effUnit === 'amt'
                ? html`<span class=${`num small-fig ${tone(dv)}`}>${money(dv, { sign: true })}　${pct(model.base ? (dv / model.base) * 100 : null)}</span>`
                : null}
              <span class="muted small">较${model.range === '1d' ? '最新净值' : '区间起点'}</span></div>`
          : null}
      </div>
      <button class="icon-btn" onClick=${onClose} aria-label="关闭">×</button>
    </header>
    <div class="fv-body">
      <div class="fv-controls">
        <${Seg} small options=${RANGES} value=${range} onChange=${set(setRange, 'range')} label="时间范围" />
        <${Seg} small options=${MODES} value=${mode} onChange=${set(setMode, 'mode2')} label="显示方式" />
        <${Seg} small options=${UNITS.map((u) => ({ ...u, disabled: stacked && u.value === 'pct', title: stacked && u.value === 'pct' ? '叠加图按金额显示' : '' }))}
          value=${effUnit} onChange=${set(setUnit, 'unit')} label="单位" />
      </div>
      ${st.err ? html`<div class="callout warn">${st.err}</div>` : null}
      ${!model ? html`<div style=${{ height: chartH + 'px' }}><${Loading} text="读取走势" /></div>` : html`
        <${TrendChart} model=${model} unit=${effUnit} stacked=${!!showBands} kind=${range} height=${chartH} />
        ${model.note ? html`<p class="field-hint">${model.note}</p>` : null}
        ${showBands
          ? html`<div class="fv-legend">
              <div class="lg-row lg-total"><span class="sw ink"></span><span class="lg-name">合计（最上沿）</span>
                <span class="num">${money(lastV)}</span></div>
              ${[...model.bands].reverse().map((b) => {
                const vals = b.values.filter((v) => v != null);
                const ch = vals.length ? vals[vals.length - 1] - vals[0] : null;
                return html`<div class="lg-row">
                  <span class="sw" style=${{ background: b.color }}></span>
                  <span class="lg-name">${b.name}${b.code ? html` <span class="muted num">${b.code}</span>` : null}</span>
                  <span class="lg-val"><span class="num">${money(vals[vals.length - 1])}</span>
                    <span class=${`num small ${tone(ch)}`}>${money(ch, { sign: true })}</span></span>
                </div>`;
              })}
            </div>
            <p class="field-hint">每只基金的市值从下往上依次叠加，任一时刻最上沿的高度就是合计市值；图例右侧是区间内的金额变化。</p>`
          : null}
      `}
    </div>
  </div>`;
}

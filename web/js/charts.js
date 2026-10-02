// 手绘 SVG 图表：净值走势、盘中估值、迷你走势线。只用线与平涂色块。
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { hm, md, money, nav as navf, pct, tone } from './fmt.js';
import { Seg } from './ui.js';

let uid = 0;

function useWidth(initial = 600) {
  const ref = useRef();
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || initial);
    const ro = new ResizeObserver((es) => setW(Math.max(160, es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceStep(span, n) {
  const raw = span / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

function ticks(lo, hi, n = 4) {
  const step = niceStep(hi - lo, n);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return { out, step };
}

function decFor(step) {
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) + 0.001)));
}

function pickIndex(e, svg, n, x0, x1) {
  const r = svg.getBoundingClientRect();
  const px = e.clientX - r.left;
  const i = Math.round(((px - x0) / (x1 - x0)) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}

const RANGES = [
  { value: 22, label: '1月' },
  { value: 66, label: '3月' },
  { value: 130, label: '6月' },
  { value: 250, label: '1年' },
];

export function NavChart({ navs, cost, buys = [], height = 230 }) {
  const [ref, w] = useWidth();
  const [range, setRange] = useState(66);
  const [hover, setHover] = useState(null);
  const pts = (navs || []).slice(-range);
  if (pts.length < 2) return html`<div ref=${ref} class="muted pad">净值数据不足</div>`;
  const vals = pts.map((p) => p[1]);
  const inRange = cost && cost > Math.min(...vals) * 0.7 && cost < Math.max(...vals) * 1.3;
  const all = inRange ? [...vals, cost] : vals;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo) * 0.1 || hi * 0.01;
  lo -= pad;
  hi += pad;
  const L = 0, R = 54, T = 10, B = 24;
  const h0 = height;
  const x = (i) => L + ((w - L - R) * i) / (pts.length - 1);
  const y = (v) => T + (h0 - T - B) * (1 - (v - lo) / (hi - lo));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const tk = ticks(lo, hi, 4);
  const dec = Math.max(2, decFor(tk.step));
  const buySet = new Set(buys);
  const chg = pts[pts.length - 1][1] / pts[0][1] - 1;
  const hp = hover != null ? pts[hover] : null;
  const move = (e) => setHover(pickIndex(e, e.currentTarget, pts.length, x(0), x(pts.length - 1)));
  const labels = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  return html`<div class="chart" ref=${ref}>
    <div class="chart-bar">
      <${Seg} small options=${RANGES} value=${range} onChange=${setRange} label="区间" />
      <span class="small">区间涨跌 <span class=${`num ${tone(chg * 100)}`}>${pct(chg * 100)}</span></span>
    </div>
    <svg width=${w} height=${h0} onPointerMove=${move} onPointerDown=${move} onPointerLeave=${() => setHover(null)}>
      ${tk.out.map((t) => html`<line class="grid" x1=${L} x2=${w - R} y1=${y(t)} y2=${y(t)} />
        <text class="tick" x=${w - R + 8} y=${y(t) + 3.5}>${t.toFixed(dec)}</text>`)}
      ${inRange
        ? html`<line class="cost" x1=${L} x2=${w - R} y1=${y(cost)} y2=${y(cost)} />
          <text class="cost-label" x=${L + 2} y=${y(cost) - 5}>成本 ${navf(cost)}</text>`
        : null}
      <path class="line" d=${d} />
      ${pts.map((p, i) => (buySet.has(p[0]) ? html`<rect class="buy" x=${x(i) - 3} y=${y(p[1]) - 3} width="6" height="6" />` : null))}
      ${labels.map((i, k) => html`<text class="tick" x=${x(i)} y=${h0 - 6} text-anchor=${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>${md(pts[i][0])}</text>`)}
      ${hp
        ? html`<line class="xh" x1=${x(hover)} x2=${x(hover)} y1=${T} y2=${h0 - B} />
          <rect class="dot" x=${x(hover) - 3.5} y=${y(hp[1]) - 3.5} width="7" height="7" />`
        : null}
    </svg>
    ${hp
      ? html`<div class="tip" style=${{ left: Math.min(Math.max(0, x(hover) - 70), w - 150) + 'px', top: '34px' }}>
          ${hp[0]}　${navf(hp[1])}${hp[3] != null ? html`　<span>${pct(hp[3])}</span>` : null}
          ${cost ? html`<br />较成本 ${pct((hp[1] / cost - 1) * 100)}` : null}
        </div>`
      : null}
  </div>`;
}

// 盘中估值：按记录顺序等距排布，时间间隔超过 20 分钟处画一条虚线（午休、收盘后到美股开盘）
export function IntradayChart({ points, value, format = 'money', height = 110, empty }) {
  const [ref, w] = useWidth(320);
  const [hover, setHover] = useState(null);
  const [id] = useState(() => 'ic' + ++uid);
  const pts = (points || []).filter((p) => value(p) != null);
  if (pts.length < 2) return html`<div ref=${ref} class="muted small" style=${{ padding: '18px 0' }}>${empty || '交易时段内每分钟记录一次估值'}</div>`;
  const vs = pts.map(value);
  let lo = Math.min(0, ...vs);
  let hi = Math.max(0, ...vs);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad;
  hi += pad;
  const L = 0, R = 4, T = 6, B = 18;
  const x = (i) => L + ((w - L - R) * i) / (pts.length - 1);
  const y = (v) => T + (height - T - B) * (1 - (v - lo) / (hi - lo));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(vs[i]).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const gaps = [];
  const starts = [0];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t - pts[i - 1].t > 20 * 60) {
      gaps.push((x(i) + x(i - 1)) / 2);
      starts.push(i);
    }
  }
  const fmt = (v) => (format === 'pct' ? pct(v) : money(v, { sign: true }));
  const last = vs[vs.length - 1];
  const hp = hover != null ? pts[hover] : null;
  const move = (e) => setHover(pickIndex(e, e.currentTarget, pts.length, x(0), x(pts.length - 1)));
  return html`<div class="chart" ref=${ref}>
    <svg width=${w} height=${height} onPointerMove=${move} onPointerDown=${move} onPointerLeave=${() => setHover(null)}>
      <defs>
        <clipPath id=${id + 'u'}><rect x="0" y="0" width=${w} height=${y(0)} /></clipPath>
        <clipPath id=${id + 'd'}><rect x="0" y=${y(0)} width=${w} height=${height} /></clipPath>
      </defs>
      <path class="area-up" d=${area} clip-path=${`url(#${id}u)`} />
      <path class="area-down" d=${area} clip-path=${`url(#${id}d)`} />
      <line class="zero" x1=${L} x2=${w - R} y1=${y(0)} y2=${y(0)} />
      ${gaps.map((g) => html`<line class="gap" x1=${g} x2=${g} y1=${T} y2=${height - B} />`)}
      <path class="line thin" d=${line} />
      ${starts.map((i) => html`<text class="tick" x=${x(i) + (i ? 4 : 0)} y=${height - 4}>${hm(pts[i].t)}</text>`)}
      <text class=${`tick strong`} x=${w - R} y=${height - 4} text-anchor="end">${hm(pts[pts.length - 1].t)} ${fmt(last)}</text>
      ${hp ? html`<line class="xh" x1=${x(hover)} x2=${x(hover)} y1=${T} y2=${height - B} />` : null}
    </svg>
    ${hp
      ? html`<div class="tip" style=${{ left: Math.min(Math.max(0, x(hover) - 60), w - 130) + 'px', top: '-6px' }}>
          ${hm(hp.t)}　${fmt(value(hp))}</div>`
      : null}
  </div>`;
}

export function Spark({ values, width = 72, height = 22 }) {
  if (!values || values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const d = values
    .map((v, i) => `${i ? 'L' : 'M'}${((width * i) / (values.length - 1)).toFixed(1)},${(height - 1 - ((height - 2) * (v - lo)) / span).toFixed(1)}`)
    .join('');
  return html`<svg class="spark" width=${width} height=${height} aria-hidden="true"><path d=${d} /></svg>`;
}

// 列表里的迷你走势：今天的盘中估算涨跌。虚线是 0，线的颜色跟着最新涨跌走
export function MiniChart({ values, width = 132, height = 34 }) {
  if (!values || values.length < 2) return null;
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const x = (i) => (width * i) / (values.length - 1);
  const y = (v) => 2 + (height - 4) * (1 - (v - lo) / span);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = values[values.length - 1];
  return html`<svg class="minichart" width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <line class="zero" x1="0" x2=${width} y1=${y(0)} y2=${y(0)} vector-effect="non-scaling-stroke" />
    <path class=${`line ${last > 0 ? 'up' : last < 0 ? 'down' : ''}`} d=${line} vector-effect="non-scaling-stroke" />
  </svg>`;
}

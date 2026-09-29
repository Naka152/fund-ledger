// 数字、日期格式化。负号用 U+2212，数字统一等宽。
export const MINUS = '−';

const fmtCache = {};
function nf(dec) {
  return (fmtCache[dec] ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
}

export function ok(v) {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export function money(v, { sign = false, dec = 2 } = {}) {
  if (!ok(v)) return '—';
  const r = Math.round(v * 10 ** dec) / 10 ** dec;
  const s = nf(dec).format(Math.abs(r));
  if (r < 0) return MINUS + s;
  return sign && r > 0 ? '+' + s : s;
}

export function pct(v, dec = 2) {
  if (!ok(v)) return '—';
  const r = Math.round(v * 10 ** dec) / 10 ** dec;
  return (r > 0 ? '+' : r < 0 ? MINUS : '') + Math.abs(r).toFixed(dec) + '%';
}

export function nav(v, dec = 4) {
  return ok(v) ? v.toFixed(dec) : '—';
}

export function plain(v, dec = 2) {
  return ok(v) ? nf(dec).format(v) : '—';
}

export function tone(v, dec = 2) {
  if (!ok(v)) return '';
  const r = Math.round(v * 10 ** dec) / 10 ** dec;
  return r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
}

export function md(d) {
  return d ? d.slice(5, 10) : '—';
}

const TZ = 'Asia/Shanghai';
const hmFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const hmsFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const wdFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, weekday: 'short' });

export function hm(ts) {
  return ts ? hmFmt.format(new Date(ts * 1000)) : '—';
}
export function hms(date) {
  return hmsFmt.format(date);
}
export function ymd(date = new Date()) {
  return dFmt.format(date);
}
export function weekday(date = new Date()) {
  return wdFmt.format(date);
}

// 行情时间：今天显示时分，否则显示日期
export function when(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return ymd(d) === ymd() ? hm(ts) : md(ymd(d)) + ' ' + hm(ts);
}

export function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

// 北京时间的 ISO 字符串（带 +08:00）
export function isoCN(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const h = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${h}:${p.minute}:${p.second}+08:00`;
}

export const FREQ_LABEL = { daily: '每个交易日', weekly: '每周', biweekly: '每两周', monthly: '每月' };
export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五'];

export function estLabel(e) {
  if (!e || e.mode === 'none') return '不估算';
  const b = ok(e.beta) ? ` ×${e.beta.toFixed(2)}` : '';
  if (e.mode === 'holdings') return `十大持仓 ${Math.round(e.src?.coverage || 0)}%${b}`;
  if (e.mode === 'link') return `链接 ${e.src?.name || ''}${b}`;
  return `${e.src?.name || '跟踪指数'}${b}`;
}

export function kindTag(r) {
  if (r.isQDII) return 'QDII';
  return { index: '指数', active: '主动', bond: '债券', money: '货币', fof: 'FOF' }[r.kind] || '';
}

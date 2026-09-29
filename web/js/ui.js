import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from './api.js';
import { money, nav as navf, pct, tone } from './fmt.js';

// 数字：变化时短暂闪一下底色（涨红跌绿）
export function Num({ v, kind = 'money', sign = false, dec, color = false, className = '' }) {
  const prev = useRef(v);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    const p = prev.current;
    prev.current = v;
    if (p == null || v == null || p === v) return;
    setFlash(v > p ? 'fl-up' : 'fl-down');
    const t = setTimeout(() => setFlash(''), 1000);
    return () => clearTimeout(t);
  }, [v]);
  const text = kind === 'pct' ? pct(v, dec ?? 2) : kind === 'nav' ? navf(v, dec ?? 4) : money(v, { sign, dec: dec ?? 2 });
  return html`<span class=${`num ${color ? tone(v, kind === 'nav' ? 4 : 2) : ''} ${flash} ${className}`}>${text}</span>`;
}

export function Seg({ options, value, onChange, small = false, label }) {
  return html`<div class=${`seg ${small ? 'small' : ''}`} role="radiogroup" aria-label=${label}>
    ${options.map(
      (o) => html`<button type="button" role="radio" aria-checked=${o.value === value} class=${o.value === value ? 'on' : ''}
        disabled=${o.disabled} title=${o.title} onClick=${() => onChange(o.value)}>${o.label}</button>`,
    )}
  </div>`;
}

export function Toggle({ on, onChange, children }) {
  return html`<button type="button" class="toggle" role="switch" aria-checked=${!!on} onClick=${() => onChange(!on)}>
    <span class="box">${on ? '✓' : ''}</span><span>${children}</span>
  </button>`;
}

export function Field({ label, hint, aside, children }) {
  return html`<div class="field">
    ${label && html`<div class="field-label"><span>${label}</span>${aside}</div>`}
    ${children}
    ${hint && html`<div class="field-hint">${hint}</div>`}
  </div>`;
}

export function NumInput({ value, onInput, placeholder, suffix, invalid, autoFocus, id }) {
  const input = html`<input id=${id} class="input" inputmode="decimal" autocomplete="off" spellcheck="false"
    value=${value} placeholder=${placeholder} aria-invalid=${invalid ? 'true' : 'false'} autofocus=${autoFocus}
    onInput=${(e) => onInput(e.target.value.replace(/[,，\s]/g, ''))} />`;
  return suffix ? html`<div class="suffix-wrap">${input}<span class="suffix">${suffix}</span></div>` : input;
}

export function Loading({ text = '载入中' }) {
  return html`<div class="loading pad">${text}</div>`;
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

let pushToast = null;
export function toast(msg, kind = '') {
  if (pushToast) pushToast({ msg, kind, id: Date.now() });
}
export function Toaster() {
  const [t, setT] = useState(null);
  pushToast = setT;
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), t.kind === 'error' ? 4500 : 2600);
    return () => clearTimeout(h);
  }, [t]);
  return t ? html`<div class=${`toast ${t.kind}`} role="status">${t.msg}</div>` : null;
}

export function Drawer({ onClose, title, sub, children, footer, width = 640 }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close.current();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('locked');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('locked');
    };
  }, []);
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <aside class="drawer" style=${{ '--w': width + 'px' }} role="dialog" aria-modal="true">
      <header class="drawer-head">
        <button class="icon-btn back" onClick=${onClose} aria-label="返回">←</button>
        <div class="drawer-title"><h3>${title}</h3>${sub && html`<div class="drawer-sub">${sub}</div>`}</div>
        <button class="icon-btn close" onClick=${onClose} aria-label="关闭">×</button>
      </header>
      <div class="drawer-body">${children}</div>
      ${footer && html`<footer class="drawer-foot">${footer}</footer>`}
    </aside>
  </div>`;
}

// 指数 / ETF / 股票搜索选择器：空关键词时列出常用指数（罗素、MSCI 等用 ETF 代理）
let catalogCache = null;
function localMatch(q) {
  const low = q.toLowerCase().replace(/\s+/g, '');
  return (catalogCache || []).filter((it) => (it.name + it.code + it.group + it.id).toLowerCase().replace(/\s+/g, '').includes(low));
}

export function InstrumentPicker({ current, onPick, autoFocus }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState(catalogCache);
  const dq = useDebounced(q.trim(), 280);
  useEffect(() => {
    if (q.trim() && catalogCache) setItems(localMatch(q.trim()));
  }, [q]);
  useEffect(() => {
    let alive = true;
    api('/instruments/search?q=' + encodeURIComponent(dq))
      .then((r) => {
        if (!dq) catalogCache = r;
        if (alive) setItems(r);
      })
      .catch(() => alive && setItems((x) => x || []));
    return () => {
      alive = false;
    };
  }, [dq]);
  let lastGroup = null;
  return html`<div class="picker">
    <input class="input text" placeholder="搜索：恒生科技、罗素成长、MSCI 日本、IWF、^RUT…" value=${q} autofocus=${autoFocus}
      onInput=${(e) => setQ(e.target.value)} />
    <div class="picker-list">
      ${items === null ? html`<div class="pick-item muted">搜索中…</div>` : null}
      ${(items || []).map((it) => {
        const g = !q.trim() && it.group !== lastGroup ? (lastGroup = it.group) : null;
        return html`${g ? html`<div class="pick-group">${g}</div>` : null}
          <button type="button" class=${`pick-item ${current === it.id ? 'on' : ''}`} onClick=${() => onPick(it)}>
            <span class="pick-name">${it.name}</span>
            <span class="pick-meta">${it.code}${it.type ? ' · ' + it.type : ''}</span>
          </button>`;
      })}
      ${items && !items.length ? html`<div class="pick-item muted">没有找到。雅虎财经代码可以直接输入，如 ^RUT、^N225</div>` : null}
    </div>
  </div>`;
}

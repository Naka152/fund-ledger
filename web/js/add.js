import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { api, fundDetail } from './api.js';
import { estLabel, isoCN, kindTag, md, money, nav as navf, pct, round2, tone, FREQ_LABEL, WEEKDAYS } from './fmt.js';
import { Drawer, Field, InstrumentPicker, Loading, Num, NumInput, Seg, Toggle, toast, useDebounced } from './ui.js';

const num = (s) => (s === '' || s == null ? NaN : Number(s));

// 快照对应的净值：默认是录入时已公布的最新净值，平台还没更新时可以改选前一天
export function snapshotChoices(detail) {
  const navs = detail?.navs || [];
  const sug = detail?.suggest?.snapshotNavDate;
  const i = navs.findIndex((r) => r[0] === sug);
  const at = i >= 0 ? i : navs.length - 1;
  return [navs[at], navs[at - 1]].filter(Boolean);
}

export function DcaFields({ v, set, meta, navNow }) {
  const amount = num(v.amount);
  const rate = num(v.feePct) / 100;
  const net = amount > 0 && rate >= 0 ? round2(amount / (1 + rate)) : null;
  const fee = net != null ? round2(amount - net) : null;
  const limit = /上限\s*([\d.]+)\s*元/.exec(meta?.buyStatus || '');
  return html`
    <div class="row2">
      <${Field} label="每期金额"><${NumInput} value=${v.amount} onInput=${(x) => set({ amount: x })} suffix="元" placeholder="如 100" /></${Field}>
      <${Field} label="申购费率" aside=${meta?.feeRateOrig != null ? html`<span class="muted">原费率 ${meta.feeRateOrig}%</span>` : null}>
        <${NumInput} value=${v.feePct} onInput=${(x) => set({ feePct: x })} suffix="%" placeholder="如 0.10" />
      </${Field}>
    </div>
    <${Field} label="频率">
      <${Seg} options=${Object.entries(FREQ_LABEL).map(([value, label]) => ({ value, label }))} value=${v.freq} onChange=${(x) => set({ freq: x })} />
    </${Field}>
    ${v.freq === 'weekly' || v.freq === 'biweekly'
      ? html`<${Field} label="扣款日"><${Seg} options=${WEEKDAYS.map((label, value) => ({ value, label }))} value=${v.weekday} onChange=${(x) => set({ weekday: x })} /></${Field}>`
      : null}
    ${v.freq === 'monthly'
      ? html`<${Field} label="每月几号" hint="遇到非交易日顺延到下一个交易日">
          <div class="select-wrap"><select class="input" value=${v.monthday} onChange=${(e) => set({ monthday: +e.target.value })}>
            ${Array.from({ length: 28 }, (_, i) => html`<option value=${i + 1}>${i + 1} 号</option>`)}
          </select></div></${Field}>`
      : null}
    ${net != null
      ? html`<div class="callout">每期扣款 <b class="num">${money(amount)}</b>，手续费 <b class="num">${money(fee)}</b>，实际买入 <b class="num">${money(net)}</b>
          ${navNow ? html`，按最新净值 <span class="num">${navf(navNow)}</span> 约 <b class="num">${money(net / navNow)}</b> 份` : null}。
          份额按扣款当天（15:00 前）的净值确认。</div>`
      : null}
    ${limit && amount > +limit[1] ? html`<div class="callout warn">这只基金目前${meta.buyStatus}，超过上限的部分会扣款失败。</div>` : null}
  `;
}

export function GroupSelect({ groups, value, onChange }) {
  return html`<div class="select-wrap"><select class="input text" value=${value} onChange=${(e) => onChange(e.target.value)}>
    ${groups.map((g) => html`<option value=${g.id}>${g.name}${g.inTotal ? '' : '（不计入总资产）'}</option>`)}
  </select></div>`;
}

export function HoldingForm({ detail, initial = {}, submitLabel, onSubmit, withExtras = false, onCancel, groups }) {
  const meta = detail.meta;
  const choices = snapshotChoices(detail);
  const [mode, setMode] = useState('shares');
  const [group, setGroup] = useState(initial.group || 'default');
  const [shares, setShares] = useState(initial.shares != null ? String(initial.shares) : '');
  const [cost, setCost] = useState(initial.cost != null ? String(initial.cost) : '');
  const [amount, setAmount] = useState('');
  const [profit, setProfit] = useState('');
  const [snapDate, setSnapDate] = useState(choices[0]?.[0]);
  const [dcaOn, setDcaOn] = useState(false);
  const [dca, setDca] = useState({ amount: '', feePct: String(meta.feeRate ?? 0), freq: 'daily', weekday: 0, monthday: 1 });
  const [link, setLink] = useState(null);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const snapNav = choices.find((c) => c[0] === snapDate)?.[1];

  let S = num(shares);
  let C = num(cost);
  if (mode === 'amount') {
    const A = num(amount);
    const P = num(profit || '0');
    S = A > 0 && snapNav ? round2(A / snapNav) : NaN;
    C = S > 0 ? (A - P) / S : NaN;
  }
  const valid = S > 0 && C > 0;
  const value = valid && snapNav ? S * snapNav : null;
  const pnl = value != null ? value - S * C : null;

  const submit = async (e) => {
    e.preventDefault();
    if (!valid) return;
    const body = { shares: round2(S), cost: Math.round(C * 10000) / 10000, snapshotAt: isoCN(), snapshotNavDate: snapDate };
    if (groups) body.group = group;
    if (withExtras && dcaOn) {
      if (!(num(dca.amount) > 0)) return toast('请填写定投金额', 'error');
      body.dca = { on: true, amount: num(dca.amount), feeRate: (num(dca.feePct) || 0) / 100, freq: dca.freq, weekday: dca.weekday, monthday: dca.monthday };
    }
    if (withExtras && link) body.est = { mode: 'link', link: { id: link.id, name: link.name }, beta: null, fx: true };
    setBusy(true);
    try {
      await onSubmit(body);
    } catch (e2) {
      toast(e2.message, 'error');
      setBusy(false);
    }
  };

  return html`<form onSubmit=${submit}>
    ${groups
      ? html`<${Field} label="分组" hint="按平台或用途分开记，比如支付宝、天天基金、模拟盘；分组可以在持仓列表上方管理。">
          <${GroupSelect} groups=${groups} value=${group} onChange=${setGroup} />
        </${Field}>`
      : null}
    <${Field} label="录入方式">
      <${Seg} options=${[{ value: 'shares', label: '份额 + 成本价' }, { value: 'amount', label: '金额 + 收益' }]} value=${mode} onChange=${setMode} />
    </${Field}>
    ${mode === 'shares'
      ? html`<div class="row2">
          <${Field} label="持有份额"><${NumInput} value=${shares} onInput=${setShares} placeholder="持仓页的「持有份额」" autoFocus /></${Field}>
          <${Field} label="持仓成本价"><${NumInput} value=${cost} onInput=${setCost} placeholder="持仓页的「持仓成本价」" /></${Field}>
        </div>`
      : html`<div class="row2">
          <${Field} label="持有金额"><${NumInput} value=${amount} onInput=${setAmount} suffix="元" autoFocus /></${Field}>
          <${Field} label="持有收益" hint="亏损填负数"><${NumInput} value=${profit} onInput=${setProfit} suffix="元" /></${Field}>
        </div>`}
    <${Field} label="平台此刻显示的净值" hint="按录入时间自动判断：默认是此刻已公布的最新净值。如果持仓页上的「最新净值」还是前一天的，就选第二项。">
      <div class="choice">
        ${choices.map((c, i) => html`<button type="button" class=${c[0] === snapDate ? 'on' : ''} onClick=${() => setSnapDate(c[0])}>
          <span><span class="num">${c[0]}</span>　<span class="num">${navf(c[1])}</span></span>
          <span class="sub">${i === 0 ? '已公布的最新净值' : '前一个净值'}</span>
        </button>`)}
      </div>
    </${Field}>
    ${valid
      ? html`<div class="callout">核对一下：持有 <b class="num">${money(S)}</b> 份，成本价 <b class="num">${navf(C)}</b>，
          按 ${md(snapDate)} 净值折合 <b class="num">${money(value)}</b> 元，持有收益 <b class=${`num ${tone(pnl)}`}>${money(pnl, { sign: true })}</b>
          （<span class=${`num ${tone(pnl)}`}>${pct((pnl / (S * C)) * 100)}</span>），应和平台上显示的一致。</div>`
      : null}
    ${withExtras
      ? html`
        <div class="block">
          <${Toggle} on=${dcaOn} onChange=${setDcaOn}>这只基金有定投</${Toggle}>
          ${dcaOn
            ? html`<${DcaFields} v=${dca} set=${(p) => setDca({ ...dca, ...p })} meta=${meta} navNow=${detail.navs.at(-1)?.[1]} />
              <div class="field-hint">平台份额里已经包含的扣款不会重复计算：本站只累计 ${md(detail.suggest.dcaStart)} 及之后的扣款
              （${meta.confirmDays >= 2 ? 'QDII 份额 T+2 确认' : '份额 T+1 确认'}），开始日期之后可以在详情里改。</div>`
            : null}
        </div>
        <div class="block">
          <div class="block-title"><h4>估算方式</h4></div>
          ${link
            ? html`<div class="picked"><span>链接到 <b>${link.name}</b> <span class="muted small num">${link.id}</span></span>
                <button type="button" class="linkish" onClick=${() => setLink(null)}>改回自动</button></div>`
            : html`<p class="note">自动：${detail.est ? estLabel(detail.est) : '不估算'}。
                <button type="button" class="linkish" onClick=${() => setLinking(!linking)}>${linking ? '收起' : '改为链接到某个指数'}</button></p>`}
          ${linking && !link ? html`<${InstrumentPicker} onPick=${(it) => { setLink(it); setLinking(false); }} />` : null}
        </div>`
      : null}
    <div class="field" style=${{ display: 'flex', gap: '10px', marginTop: '22px' }}>
      <button class="btn primary" disabled=${!valid || busy}>${busy ? '保存中…' : submitLabel}</button>
      ${onCancel ? html`<button type="button" class="btn" onClick=${onCancel}>取消</button>` : null}
    </div>
  </form>`;
}

function FundHeader({ detail }) {
  const m = detail.meta;
  const last = detail.navs.at(-1);
  const e = detail.est;
  return html`<div class="block">
    <div class="kv" style=${{ borderBottom: 0 }}>
      <div><div class="k">最新净值</div><div class="v"><${Num} v=${last?.[1]} kind="nav" /></div><div class="s">${last?.[0]} <${Num} v=${last?.[3]} kind="pct" color /></div></div>
      <div><div class="k">估算</div><div class="v">${e?.live ? html`<${Num} v=${e.estPct} kind="pct" color />` : '—'}</div><div class="s">${e ? estLabel(e) : '不估算'}</div></div>
      <div><div class="k">类型</div><div class="v" style=${{ fontFamily: 'var(--f-sans)', fontSize: '14px' }}>${m.type || '—'}</div><div class="s">${m.company || ''}</div></div>
      <div><div class="k">申购</div><div class="v" style=${{ fontFamily: 'var(--f-sans)', fontSize: '14px' }}>${m.buyStatus || '—'}</div><div class="s">费率 ${m.feeRate ?? '—'}%</div></div>
    </div>
  </div>`;
}

export function AddFund({ onClose, onAdded, mode = 'hold', groups, defaultGroup = 'default', presetCode, favCodes = [] }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(presetCode ? { code: presetCode, name: presetCode, type: '' } : null);
  const [faved, setFaved] = useState(() => new Set(favCodes));
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const dq = useDebounced(q.trim(), 180);
  const inputRef = useRef();

  useEffect(() => {
    if (!dq) return setResults(null);
    let alive = true;
    api('/funds/search?q=' + encodeURIComponent(dq))
      .then((r) => alive && (setResults(r), setCursor(0)))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [dq]);

  useEffect(() => {
    if (!sel) return;
    setDetail(null);
    setErr(null);
    fundDetail(sel.code, true)
      .then(setDetail)
      .catch((e) => setErr(e.message));
  }, [sel]);

  const addFav = async (r) => {
    try {
      await api('/favs', { method: 'POST', body: { code: r.code } });
      setFaved(new Set([...faved, r.code]));
      toast(`已加入自选：${r.name}`);
      if (mode === 'fav') onAdded();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const pick = (r) => (mode === 'fav' ? addFav(r) : setSel(r));

  const onKey = (e) => {
    if (!results?.length) return;
    if (e.key === 'ArrowDown') (setCursor(Math.min(cursor + 1, results.length - 1)), e.preventDefault());
    if (e.key === 'ArrowUp') (setCursor(Math.max(cursor - 1, 0)), e.preventDefault());
    if (e.key === 'Enter') (pick(results[cursor]), e.preventDefault());
  };

  const save = async (body) => {
    await api('/holdings', { method: 'POST', body: { ...body, code: sel.code, name: detail.meta.name } });
    toast(`已添加 ${detail.meta.name}`);
    onAdded();
  };

  if (sel) {
    const name = detail?.meta?.name || sel.name;
    return html`<${Drawer} title=${name} sub=${html`<span class="num">${sel.code}</span><span>${detail?.meta?.type || sel.type}</span>`} onClose=${onClose} width=${620}>
      <div class="pad add-actions">
        ${presetCode ? html`<span></span>` : html`<button class="linkish" onClick=${() => { setSel(null); setDetail(null); }}>← 换一只</button>`}
        ${faved.has(sel.code)
          ? html`<span class="muted small">★ 已在自选</span>`
          : html`<button class="linkish" onClick=${() => addFav({ code: sel.code, name })}>☆ 加入自选</button>`}
      </div>
      ${err ? html`<div class="callout warn">${err}</div>` : null}
      ${!detail && !err ? html`<${Loading} text="读取基金资料" />` : null}
      ${detail ? html`<${FundHeader} detail=${detail} /><${HoldingForm} detail=${detail} submitLabel="保存到持仓" onSubmit=${save} withExtras
          groups=${groups} initial=${{ group: defaultGroup }} />` : null}
    </${Drawer}>`;
  }

  const fav = mode === 'fav';
  return html`<${Drawer} title=${fav ? '添加自选' : '添加基金'} sub=${fav ? '搜索后点一下就加入自选，首页可以看到它的估值走势' : '输入代码、名称或拼音首字母'} onClose=${onClose} width=${620}>
    <div class="field" style=${{ marginTop: '18px' }}>
      <input ref=${inputRef} class="input text" placeholder="如 022424、中证A500、纳斯达克、yfdlc" value=${q} autofocus
        onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey} />
    </div>
    ${err ? html`<div class="callout warn">${err}</div>` : null}
    <div class="results">
      ${(results || []).map((r, i) => html`<button type="button" class=${`result ${i === cursor ? 'on' : ''}`} onClick=${() => pick(r)} onMouseEnter=${() => setCursor(i)}>
        <span class="code">${r.code}</span><span class="nm">${r.name}</span><span class="muted small">${fav && faved.has(r.code) ? '★ 已在自选' : r.type}</span>
      </button>`)}
      ${results && !results.length ? html`<div class="pad muted">没有找到这只基金</div>` : null}
      ${!results ? html`<div class="pad note">支持场外基金和场内 ETF / LOF。估算方式会自动选择：指数基金跟踪其指数，主动基金用前十大重仓股，之后可以改成链接到任意指数。</div>` : null}
    </div>
  </${Drawer}>`;
}

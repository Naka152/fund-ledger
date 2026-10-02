// 持仓分组（筛选条、分组管理）与自选列表
import { html, useState } from '../vendor/preact-htm.js';
import { api } from './api.js';
import { MiniChart, Spark } from './charts.js';
import { fundPoint } from './detail.js';
import { estLabel, kindTag, md, when } from './fmt.js';
import { Drawer, Num, Toggle, toast } from './ui.js';

const SUGGESTED = ['支付宝', '天天基金', '蚂蚁财富', '招商银行', '且慢', '京东金融', '模拟盘'];

export function GroupBar({ groups, value, total, onChange, onManage }) {
  const shown = groups.filter((g) => g.count > 0 || g.id === value);
  return html`<div class="gbar">
    <div class="seg small" role="radiogroup" aria-label="持仓分组">
      <button type="button" role="radio" aria-checked=${value === 'all'} class=${value === 'all' ? 'on' : ''} onClick=${() => onChange('all')}>
        全部 <span class="gcount">${total}</span>
      </button>
      ${shown.map((g) => html`<button type="button" role="radio" aria-checked=${value === g.id} class=${value === g.id ? 'on' : ''}
          onClick=${() => onChange(g.id)}>
          ${g.name} <span class="gcount">${g.count}</span>${g.inTotal ? null : html`<span class="gnote">不计入</span>`}
        </button>`)}
    </div>
    <button class="linkish small" onClick=${onManage}>管理分组</button>
  </div>`;
}

export function GroupManager({ groups, onClose, onSaved }) {
  const [list, setList] = useState(groups.map((g) => ({ id: g.id, name: g.name, inTotal: g.inTotal, count: g.count })));
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (i, patch) => setList(list.map((g, k) => (k === i ? { ...g, ...patch } : g)));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const l = [...list];
    [l[i], l[j]] = [l[j], l[i]];
    setList(l);
  };
  const remove = (i) => {
    const g = list[i];
    if (g.count && !confirm(`删除「${g.name}」后，其中的 ${g.count} 只基金会移到默认分组。`)) return;
    setList(list.filter((_, k) => k !== i));
  };
  const add = (n) => {
    const v = (n ?? name).trim();
    if (!v) return;
    if (list.some((g) => g.name === v)) return toast(`已经有「${v}」了`, 'error');
    setList([...list, { name: v, inTotal: v !== '模拟盘', count: 0 }]);
    setName('');
  };
  const save = async () => {
    if (list.some((g) => !g.name.trim())) return toast('分组名称不能为空', 'error');
    setSaving(true);
    try {
      await api('/groups', { method: 'PUT', body: { groups: list.map(({ id, name: n, inTotal }) => ({ id, name: n.trim(), inTotal })) } });
      toast('分组已保存');
      onSaved();
      onClose();
    } catch (e) {
      toast(e.message, 'error');
      setSaving(false);
    }
  };
  const missing = SUGGESTED.filter((n) => !list.some((g) => g.name === n));
  return html`<${Drawer} title="持仓分组" sub="按平台或用途分开记账，比如支付宝、天天基金、模拟盘" width=${560} onClose=${onClose}
    footer=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" disabled=${saving} onClick=${save}>保存</button>`}>
    <div class="block">
      <div class="glist">
        ${list.map((g, i) => html`<div class="grow" key=${g.id || 'new' + i}>
          <input class="input text" value=${g.name} maxlength="16" aria-label="分组名称" onInput=${(e) => set(i, { name: e.target.value })} />
          <span class="muted small nowrap">${g.count || 0} 只</span>
          <${Toggle} on=${g.inTotal} onChange=${(v) => set(i, { inTotal: v })}>计入总资产</${Toggle}>
          <span class="grow-btns">
            <button class="icon-btn" aria-label="上移" onClick=${() => move(i, -1)}>↑</button>
            <button class="icon-btn" aria-label="下移" onClick=${() => move(i, 1)}>↓</button>
            ${g.id === 'default'
              ? html`<span class="icon-btn muted" title="默认分组不能删除，可以改名">·</span>`
              : html`<button class="icon-btn" aria-label="删除" onClick=${() => remove(i)}>×</button>`}
          </span>
        </div>`)}
      </div>
      <p class="field-hint">关掉「计入总资产」的分组（比如模拟盘）照常估算，但不算进首页「全部」的总资产和估值走势。默认分组不能删除，可以改名。</p>
    </div>
    <div class="block">
      <div class="block-title"><h4>添加分组</h4></div>
      <form class="gadd" onSubmit=${(e) => { e.preventDefault(); add(); }}>
        <input class="input text" placeholder="分组名称，最多 16 个字" maxlength="16" value=${name} onInput=${(e) => setName(e.target.value)} />
        <button class="btn" disabled=${!name.trim()}>添加</button>
      </form>
      ${missing.length
        ? html`<div class="chips">${missing.map((n) => html`<button type="button" class="chip" onClick=${() => add(n)}>＋ ${n}</button>`)}</div>`
        : null}
    </div>
  </${Drawer}>`;
}

function favTrend(intraday, code) {
  return (intraday || []).map((p) => fundPoint(p, code)).filter((v) => v != null);
}

function FavEst({ r }) {
  const e = r.est || {};
  if (r.error) return html`<span class="muted small">${r.error}</span>`;
  if (!e.mode || e.mode === 'none') return html`<span class="muted small">不估算</span>`;
  if (!e.live) return html`<span class="muted small">暂无新行情</span>`;
  return html`<${Num} v=${e.estPct} kind="pct" color />`;
}

export function FavList({ rows, intraday, heldCodes, onOpen, onRemove }) {
  const remove = (e, r) => {
    e.stopPropagation();
    onRemove(r);
  };
  return html`
    <table class="tbl favtbl">
      <thead><tr>
        <th>基金 · 估算依据</th><th>最新净值</th><th>估算涨跌</th><th>今日走势</th><th>近一月</th><th>近三月</th><th>近一年</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map((r) => {
          const vals = favTrend(intraday, r.code);
          return html`<tr class="row" key=${r.code} onClick=${() => onOpen(r.code)}>
            <td><div class="fund-cell">
              <div class="fund-name">${r.name}</div>
              <div class="fund-meta"><span class="code">${r.code}</span>${kindTag(r) && html`<span class="tag">${kindTag(r)}</span>`}
                <span class="src-line">${estLabel(r.est)}</span>${heldCodes.has(r.code) ? html`<span class="tag">已持有</span>` : null}</div>
            </div></td>
            <td><div class="cell-main"><${Num} v=${r.nav} kind="nav" /></div>
              <div class="cell-sub">${md(r.navDate)} <${Num} v=${r.navPct} kind="pct" color /></div></td>
            <td><div class="cell-big"><${FavEst} r=${r} /></div>
              <div class="cell-sub">${r.est?.live ? html`估 <${Num} v=${r.est.estNav} kind="nav" /> · ${when(r.est.src?.ts)}` : ''}</div></td>
            <td class="trend">${vals.length > 1 ? html`<${MiniChart} values=${vals} />` : html`<span class="muted small">开盘后显示</span>`}</td>
            <td><div class="spark-cell"><${Spark} values=${(r.spark || []).slice(-22)} width=${64} height=${20} /><${Num} v=${r.m1} kind="pct" color /></div></td>
            <td><div class="cell-main"><${Num} v=${r.m3} kind="pct" color /></div></td>
            <td><div class="cell-main"><${Num} v=${r.y1} kind="pct" color /></div></td>
            <td><button class="icon-btn" title="移出自选" aria-label="移出自选" onClick=${(e) => remove(e, r)}>×</button></td>
          </tr>`;
        })}
      </tbody>
    </table>
    <div class="cards">
      ${rows.map((r) => {
        const vals = favTrend(intraday, r.code);
        return html`<button type="button" class="card" key=${r.code} onClick=${() => onOpen(r.code)}>
          <div>
            <div class="fund-name">${r.name}</div>
            <div class="fund-meta"><span class="code">${r.code}</span>${kindTag(r) && html`<span class="tag">${kindTag(r)}</span>`}<span>${estLabel(r.est)}</span></div>
          </div>
          <div>
            <div class="pct-big"><${FavEst} r=${r} /></div>
            <div class="right-sub">净值 <${Num} v=${r.nav} kind="nav" /> <${Num} v=${r.navPct} kind="pct" color /></div>
          </div>
          <div class="card-trend">${vals.length > 1 ? html`<${MiniChart} values=${vals} width=${320} height=${40} />` : null}</div>
          <div class="card-figs">
            <div><span>近一月</span><${Num} v=${r.m1} kind="pct" color /></div>
            <div><span>近三月</span><${Num} v=${r.m3} kind="pct" color /></div>
            <div><span>近一年</span><${Num} v=${r.y1} kind="pct" color /></div>
          </div>
        </button>`;
      })}
    </div>`;
}

export function FavEmpty({ onAdd }) {
  return html`<div class="empty">
    <h3>还没有自选基金</h3>
    <p>自选的基金不用填份额，首页就能看到它的实时估算和走势。可以在这里搜索添加，也可以在持仓详情里点「☆ 加自选」。</p>
    <button class="btn primary" onClick=${onAdd}>＋ 添加自选</button>
  </div>`;
}

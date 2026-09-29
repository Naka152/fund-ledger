import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.js';
import { DcaFields, HoldingForm } from './add.js';
import { api, fundDetail } from './api.js';
import { IntradayChart, NavChart } from './charts.js';
import { estLabel, isoCN, kindTag, md, money, nav as navf, pct, plain, tone, when, FREQ_LABEL, WEEKDAYS } from './fmt.js';
import { Drawer, Field, InstrumentPicker, Loading, Num, NumInput, Seg, Toggle, toast, useDebounced } from './ui.js';

const TABS = [
  { value: 'overview', label: '概览' },
  { value: 'est', label: '估算' },
  { value: 'dca', label: '定投' },
  { value: 'top', label: '十大持仓' },
  { value: 'edit', label: '更新持仓' },
];

function KeyFigures({ row }) {
  const e = row.est || {};
  return html`<div class="kv">
    <div><div class="k">最新净值</div><div class="v"><${Num} v=${row.nav} kind="nav" /></div>
      <div class="s">${md(row.navDate)} <${Num} v=${row.navPct} kind="pct" color /></div></div>
    <div><div class="k">估算净值</div><div class="v">${e.live ? html`<${Num} v=${e.estNav} kind="nav" />` : '—'}</div>
      <div class="s">${e.live ? html`<${Num} v=${e.estPct} kind="pct" color /> ${when(e.src?.ts)}` : '暂无新行情'}</div></div>
    <div><div class="k">持有份额</div><div class="v"><${Num} v=${row.shares} /></div>
      <div class="s">成本价 <${Num} v=${row.costPrice} kind="nav" /></div></div>
    <div><div class="k">持有金额</div><div class="v"><${Num} v=${row.value} /></div>
      <div class="s">估算 <${Num} v=${row.estValue} /></div></div>
    <div><div class="k">持有收益</div><div class="v"><${Num} v=${row.pnl} sign color /></div>
      <div class="s"><${Num} v=${row.pnlPct} kind="pct" color /></div></div>
    <div><div class="k">估算盈亏</div><div class="v"><${Num} v=${row.estDayPnl} sign color /></div>
      <div class="s">最新一日 <${Num} v=${row.dayPnl} sign color /></div></div>
    <div><div class="k">投入成本</div><div class="v"><${Num} v=${row.cost} /></div>
      <div class="s">${row.pending > 0 ? `在途 ${money(row.pending)}` : '不含在途'}</div></div>
    <div><div class="k">支付宝快照</div><div class="v" style=${{ fontSize: '14px' }}>${(row.snapshotAt || '').slice(0, 16).replace('T', ' ')}</div>
      <div class="s">对应 ${md(row.snapshotNavDate)} 净值</div></div>
  </div>`;
}

function Overview({ row, detail, intraday, ledger }) {
  const pts = (intraday || []).filter((p) => p.h && p.h[row.id] != null);
  const buys = (ledger || []).filter((e) => e.status === 'done').map((e) => e.navDate);
  const le = row.lastEst;
  return html`
    ${le
      ? html`<div class="callout">上次估算 ${md(le.date)}：估 <b class=${`num ${tone(le.est)}`}>${pct(le.est)}</b>，
          实际 <b class=${`num ${tone(le.actual)}`}>${pct(le.actual)}</b>，偏差 <span class="num">${pct(le.est - le.actual)}</span></div>`
      : null}
    <div class="block">
      <div class="block-title"><h4>今日估算走势</h4><span class="muted small">${estLabel(row.est)}</span></div>
      <${IntradayChart} points=${pts} value=${(p) => p.h[row.id]} format="pct" height=${120}
        empty="交易时段内每分钟记录一次，开盘后这里会画出估算涨跌" />
    </div>
    <div class="block">
      <div class="block-title"><h4>净值走势</h4><span class="muted small">虚线为持仓成本${buys.length ? '，黄色方块为定投' : ''}</span></div>
      ${detail ? html`<${NavChart} navs=${detail.navs} cost=${row.costPrice} buys=${buys} />` : html`<${Loading} />`}
    </div>
    ${detail
      ? html`<div class="block note">
          <div class="block-title"><h4>基金资料</h4></div>
          <div>${detail.meta.fullName || detail.meta.name}</div>
          <div>${detail.meta.company || ''}${detail.meta.manager ? ' · 基金经理 ' + detail.meta.manager : ''}${detail.meta.established ? ' · 成立于 ' + detail.meta.established : ''}</div>
          ${detail.meta.bench ? html`<div>业绩基准：${detail.meta.bench}</div>` : null}
          <div>申购状态：${detail.meta.buyStatus || '—'} · 申购费率 ${detail.meta.feeRate ?? '—'}%（原 ${detail.meta.feeRateOrig ?? '—'}%）· 份额 T+${detail.meta.confirmDays} 确认</div>
        </div>`
      : null}`;
}

function EstimateTab({ row, detail, onChanged }) {
  const meta = detail.meta;
  const cfg = row.estCfg || { mode: 'auto' };
  const [mode, setMode] = useState(cfg.mode || 'auto');
  const [link, setLink] = useState(cfg.link || null);
  const [beta, setBeta] = useState(cfg.beta != null ? String(cfg.beta) : '');
  const [fx, setFx] = useState(cfg.fx !== false);
  const [picking, setPicking] = useState(false);
  const [bt, setBt] = useState(null);
  const [busy, setBusy] = useState(false);
  const e = row.est || {};
  const draft = useDebounced(JSON.stringify({ mode, link: link?.id, beta, fx }), 450);
  const dirty = draft !== JSON.stringify({ mode: cfg.mode || 'auto', link: cfg.link?.id, beta: cfg.beta != null ? String(cfg.beta) : '', fx: cfg.fx !== false });
  const noIndex = !meta.indexId;
  const noStocks = !(meta.stocks || []).length;

  useEffect(() => {
    const d = JSON.parse(draft);
    if (d.mode === 'link' && !d.link) return;
    setBt(null);
    const qs = new URLSearchParams({ hid: row.id, mode: d.mode, fx: d.fx ? '1' : '0' });
    if (d.link) qs.set('link', d.link);
    if (d.beta) qs.set('beta', d.beta);
    let alive = true;
    api(`/funds/${row.code}/backtest?${qs}`)
      .then((r) => alive && setBt(r))
      .catch((err) => alive && setBt({ error: err.message }));
    return () => {
      alive = false;
    };
  }, [draft]);

  const save = async () => {
    setBusy(true);
    try {
      await api('/holdings/' + row.id, { method: 'PATCH', body: { est: { mode, link: mode === 'link' ? link : null, beta: beta === '' ? null : Number(beta), fx } } });
      toast('估算方式已保存');
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy(false);
  };

  const sameCfg = mode === (cfg.mode || 'auto') && (mode !== 'link' || link?.id === cfg.link?.id);
  const defBeta = mode === 'index' || (mode === 'auto' && meta.isIndex && meta.indexId)
    ? meta.benchRatio || meta.stockRatio || 0.95
    : mode === 'link' ? meta.stockRatio || meta.benchRatio || 0.9 : meta.stockRatio || 0.9;
  const autoBeta = sameCfg && e.fit?.beta ? e.fit.beta : defBeta;
  const betaNote = e.betaSrc === 'manual' ? '手动设置'
    : e.betaSrc === 'fit' ? `自动校准：近 ${e.fit?.n} 个净值日拟合，相关系数 ${e.fit?.corr?.toFixed(3)}`
    : '默认：' + (e.mode === 'index' ? '业绩基准中的指数比例' : '最近一期股票仓位');

  return html`
    <div class="block">
      <div class="block-title"><h4>当前估算</h4><span class="muted small">${e.src?.ts ? '行情 ' + when(e.src.ts) : ''}</span></div>
      ${e.mode && e.mode !== 'none' && e.src
        ? html`<div class="note">
            依据 <b>${estLabel(e)}</b>：${e.mode === 'holdings' ? '十大持仓加权' : e.src.name}自 ${md(row.navDate)} 收盘以来
            <span class=${`num ${tone(e.src.pct)}`}>${pct(e.src.pct)}</span>
            ${e.src.fxPct != null ? html`，汇率 <span class="num">${pct(e.src.fxPct, 3)}</span>` : null}
            → 估算净值 <b class="num">${navf(e.estNav)}</b>（<span class=${`num ${tone(e.estPct)}`}>${pct(e.estPct)}</span>）
            ${!e.live ? '。最新净值已经包含标的最新收盘，暂无新的涨跌。' : ''}
            <div class="muted small" style=${{ marginTop: '4px' }}>β = ${e.beta?.toFixed(2)}，${betaNote}</div>
          </div>`
        : html`<div class="note">${e.error || '这只基金目前不做估算（货币基金、债券基金，或找不到可用的行情）。'}</div>`}
    </div>
    <div class="block">
      <div class="block-title"><h4>估算方式</h4></div>
      <${Seg} options=${[
        { value: 'auto', label: '自动' },
        { value: 'index', label: '跟踪指数', disabled: noIndex, title: noIndex ? '没有识别到跟踪指数' : meta.indexLabel },
        { value: 'holdings', label: '十大持仓', disabled: noStocks },
        { value: 'link', label: '链接指数' },
        { value: 'none', label: '不估算' },
      ]} value=${mode} onChange=${(v) => { setMode(v); if (v === 'link' && !link) setPicking(true); }} />
      <p class="field-hint">
        ${mode === 'auto' ? (meta.indexId && meta.isIndex ? `自动：跟踪 ${meta.indexLabel}` : noStocks ? '自动：不估算' : '自动：前十大重仓股加权') : null}
        ${mode === 'index' ? `跟踪指数：${meta.indexLabel || '—'}（${meta.indexName || meta.indexCode || ''}${meta.indexVia === 'etf' ? '，用目标 ETF 代理' : ''}）` : null}
        ${mode === 'holdings' ? `前十大重仓股来自 ${meta.stocksDate || '最近一期'} 报告，合计占净值 ${plain((meta.stocks || []).reduce((a, s) => a + s.weight, 0), 1)}%，按股票仓位 ${meta.stockRatio ? Math.round(meta.stockRatio * 100) + '%' : '—'} 缩放` : null}
        ${mode === 'link' ? '把这只基金的当日涨跌挂到一个你认为走势相近的指数、ETF 或股票上，例如港股主动基金 → 恒生科技。' : null}
      </p>
      ${mode === 'link'
        ? html`${link && !picking
            ? html`<div class="picked"><span>链接到 <b>${link.name}</b> <span class="muted small num">${link.id}</span></span>
                <button class="linkish" onClick=${() => setPicking(true)}>更换</button></div>`
            : html`<${InstrumentPicker} current=${link?.id} autoFocus onPick=${(it) => { setLink({ id: it.id, name: it.name }); setPicking(false); }} />`}`
        : null}
      ${mode !== 'none'
        ? html`<div class="row2">
            <${Field} label="仓位系数 β" hint=${`留空为自动（${autoBeta.toFixed(2)}${sameCfg && e.fit?.beta ? '，历史拟合' : ''}）。估算涨跌 = β × 标的涨跌`}>
              <${NumInput} value=${beta} onInput=${setBeta} placeholder=${autoBeta.toFixed(2)} />
            </${Field}>
            <${Field} label="汇率" hint="海外标的叠加人民币中间价变化">
              <div style=${{ paddingTop: '8px' }}><${Toggle} on=${fx} onChange=${setFx}>计入汇率变化</${Toggle}></div>
            </${Field}>
          </div>`
        : null}
      <button class="btn primary" disabled=${busy || !dirty || (mode === 'link' && !link)} onClick=${save}>保存估算方式</button>
    </div>
    ${mode !== 'none' ? html`<${Backtest} bt=${bt} onUseBeta=${(b) => setBeta(b.toFixed(2))} />` : null}`;
}

function Backtest({ bt, onUseBeta }) {
  if (!bt) return html`<div class="block"><${Loading} text="用历史净值检验这种估算方式" /></div>`;
  if (bt.error) return html`<div class="block"><div class="callout warn">${bt.error}</div></div>`;
  if (!bt.n || bt.n < 5) return html`<div class="block note">历史数据不足，暂时无法检验。</div>`;
  const q = bt.corr >= 0.95 ? '很贴合' : bt.corr >= 0.85 ? '比较贴合' : bt.corr >= 0.7 ? '一般' : '偏差较大';
  return html`<div class="block">
    <div class="block-title"><h4>历史检验</h4><span class="muted small">${md(bt.from)} — ${md(bt.to)} · ${bt.n} 个净值日</span></div>
    <div class="stats">
      <div><div class="k">相关系数</div><div class="v">${bt.corr != null ? bt.corr.toFixed(3) : '—'}</div></div>
      <div><div class="k">日均估算误差</div><div class="v">${bt.mae.toFixed(2)}%</div></div>
      <div><div class="k">方向命中</div><div class="v">${Math.round(bt.hit * 100)}%</div></div>
      <div><div class="k">拟合 β</div><div class="v">${bt.betaFit != null ? bt.betaFit.toFixed(2) : '—'}</div></div>
    </div>
    <p class="note">当前设置 ${q}。按拟合 β ${bt.betaFit?.toFixed(2)} 估算，日均误差会是 ${bt.maeFit?.toFixed(2)}%。
      ${bt.betaFit != null && Math.abs(bt.betaFit - bt.beta) > 0.03 ? html` <button class="linkish" onClick=${() => onUseBeta(bt.betaFit)}>采用拟合 β</button>` : null}</p>
    <table class="mini">
      <thead><tr><th>净值日</th><th>标的</th><th>估算</th><th>实际</th><th>偏差</th></tr></thead>
      <tbody>${bt.days.map((d) => html`<tr>
        <td class="num">${md(d.date)}</td>
        <td><span class="num">${pct(d.src)}</span></td>
        <td><span class=${`num ${tone(d.est)}`}>${pct(d.est)}</span></td>
        <td><span class=${`num ${tone(d.actual)}`}>${pct(d.actual)}</span></td>
        <td><span class="num">${pct(d.est - d.actual)}</span></td>
      </tr>`)}</tbody>
    </table>
  </div>`;
}

function DcaTab({ row, detail, ledger, reloadLedger, onChanged }) {
  const meta = detail.meta;
  const c = row.dcaCfg;
  const [on, setOn] = useState(c ? c.on : true);
  const [v, setV] = useState({
    amount: c ? String(c.amount) : '',
    feePct: c ? String(+(c.feeRate * 100).toFixed(4)) : String(meta.feeRate ?? 0),
    freq: c?.freq || 'daily', weekday: c?.weekday ?? 0, monthday: c?.monthday ?? 1,
    start: c?.start || row.dcaSuggestStart || '', end: c?.end || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (p) => setV({ ...v, ...p });

  const payload = (extra = {}) => ({
    on, amount: Number(v.amount), feeRate: (Number(v.feePct) || 0) / 100, freq: v.freq, weekday: v.weekday,
    monthday: v.monthday, start: v.start || null, end: v.end || null, skips: c?.skips || [], ...extra,
  });
  const save = async (body, msg) => {
    setBusy(true);
    try {
      await api('/holdings/' + row.id, { method: 'PATCH', body: { dca: body } });
      toast(msg);
      onChanged();
      reloadLedger();
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy(false);
  };
  const toggleSkip = (date) => {
    const skips = new Set(c?.skips || []);
    skips.has(date) ? skips.delete(date) : skips.add(date);
    save({ ...c, skips: [...skips] }, skips.has(date) ? `${md(date)} 这笔已标记为未扣款` : `${md(date)} 这笔已恢复`);
  };
  const s = row.dca;
  return html`
    <div class="block">
      <div class="block-title"><h4>定投计划</h4>${c ? html`<${Toggle} on=${on} onChange=${setOn}>${on ? '执行中' : '已暂停'}</${Toggle}>` : null}</div>
      <${DcaFields} v=${v} set=${set} meta=${meta} navNow=${row.nav} />
      <div class="row2">
        <${Field} label="从哪天开始计入" hint=${`默认 ${md(row.dcaSuggestStart)}：快照时支付宝份额里还没有这笔及之后的扣款`}>
          <input class="input" type="date" value=${v.start} onInput=${(e) => set({ start: e.target.value })} />
        </${Field}>
        <${Field} label="结束日期" hint="可不填">
          <input class="input" type="date" value=${v.end} onInput=${(e) => set({ end: e.target.value })} />
        </${Field}>
      </div>
      <div style=${{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <button class="btn primary" disabled=${busy || !(Number(v.amount) > 0)} onClick=${() => save(payload(), '定投计划已保存')}>保存定投</button>
        ${c ? html`<button class="btn danger" disabled=${busy} onClick=${() => confirm('删除定投计划？已累计的定投份额也会一并移除。') && save(null, '定投计划已删除')}>删除计划</button>` : null}
      </div>
    </div>
    ${c
      ? html`<div class="block">
          <div class="block-title"><h4>定投台账</h4><span class="muted small">下次扣款 ${s?.next ? md(s.next) : '—'}</span></div>
          ${s ? html`<div class="stats">
            <div><div class="k">已确认</div><div class="v">${s.count} 期</div></div>
            <div><div class="k">累计扣款</div><div class="v">${money(s.invested)}</div></div>
            <div><div class="k">累计份额</div><div class="v">${money(s.shares)}</div></div>
            <div><div class="k">手续费</div><div class="v">${money(s.fees)}</div></div>
          </div>` : null}
          ${!ledger ? html`<${Loading} />` : !ledger.length ? html`<p class="note">还没有需要本站累计的扣款。</p>` : html`
          <table class="mini">
            <thead><tr><th>扣款日</th><th>扣款</th><th>手续费</th><th>确认净值</th><th>份额</th><th></th></tr></thead>
            <tbody>${ledger.slice(0, 120).map((e) => html`<tr class=${e.status === 'skipped' ? 'dim' : ''}>
              <td class="num">${md(e.date)}</td>
              <td><span class="num">${money(e.amount)}</span></td>
              <td><span class="num">${money(e.fee)}</span></td>
              <td>${e.status === 'done' ? html`<span class="num">${navf(e.nav)}</span>${e.navDate !== e.date ? html` <span class="muted small">${md(e.navDate)}</span>` : null}` : html`<span class="muted">${e.status === 'skipped' ? '未扣款' : '待确认'}</span>`}</td>
              <td>${e.status === 'done' ? html`<span class="num">${money(e.shares)}</span>` : '—'}</td>
              <td><button class="linkish small" onClick=${() => toggleSkip(e.date)}>${e.status === 'skipped' ? '恢复' : '没扣'}</button></td>
            </tr>`)}</tbody>
          </table>`}
          <p class="field-hint">扣款日按 A 股交易日计算；如果某天余额不足或暂停申购没有扣款，点「没扣」把它排除。</p>
        </div>`
      : null}`;
}

function TopTab({ row, detail }) {
  const meta = detail.meta;
  const parts = row.est?.mode === 'holdings' ? row.est.parts : null;
  const [quotes, setQuotes] = useState(null);
  useEffect(() => {
    if (parts || !(meta.stocks || []).length) return;
    api('/quotes?ids=' + meta.stocks.map((s) => s.id).join(','))
      .then(setQuotes)
      .catch(() => setQuotes({}));
  }, []);
  const list = parts || (meta.stocks || []).map((s) => ({ ...s, dayPct: quotes?.[s.id]?.pct }));
  if (!list.length) return html`<div class="block note">没有股票持仓数据${meta.etfName ? `（联接基金主要持有 ${meta.etfName}）` : ''}。</div>`;
  const sum = list.reduce((a, s) => a + s.weight, 0);
  return html`<div class="block">
    <div class="block-title"><h4>前十大重仓股</h4><span class="muted small">${meta.stocksDate || ''} 报告</span></div>
    <table class="mini">
      <thead><tr><th>股票</th><th>占净值</th><th>今日</th>${parts ? html`<th>估算贡献</th>` : null}</tr></thead>
      <tbody>${list.map((s) => html`<tr>
        <td>${s.name} <span class="muted small num">${s.code}</span></td>
        <td><span class="bar" style=${{ width: Math.max(2, s.weight * 4) + 'px', background: 'var(--ink-3)' }}></span><span class="num">${plain(s.weight)}%</span></td>
        <td><${Num} v=${s.dayPct} kind="pct" color /></td>
        ${parts ? html`<td><${Num} v=${s.contrib} kind="pct" dec=${3} color /></td>` : null}
      </tr>`)}</tbody>
    </table>
    <p class="field-hint">前十合计占净值 ${plain(sum, 1)}%，股票仓位 ${meta.stockRatio ? plain(meta.stockRatio * 100, 1) + '%' : '—'}（${meta.allocDate || '—'}）。季报在季度结束后 15 个工作日内披露，期间的调仓无法反映。</p>
  </div>`;
}

function EditTab({ row, detail, onChanged, onDeleted }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const save = async (body) => {
    if (row.dcaCfg) body.dca = { ...row.dcaCfg, start: null };
    await api('/holdings/' + row.id, { method: 'PATCH', body });
    toast('持仓已更新');
    onChanged();
  };
  const del = async () => {
    if (!armed) return setArmed(true);
    try {
      await api('/holdings/' + row.id, { method: 'DELETE' });
      toast(`已删除 ${row.name}`);
      onDeleted();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return html`
    <div class="block note">
      买卖之后，照着支付宝最新的份额和成本价重新录入即可。快照时间会更新为现在，
      ${row.dcaCfg ? '定投会从新快照之后的第一笔扣款重新开始累计。' : ''}
    </div>
    <${HoldingForm} detail=${detail} initial=${{ shares: row.snapShares, cost: row.snapCost }} submitLabel="用支付宝最新数据更新" onSubmit=${save} />
    <div class="block">
      <div class="block-title"><h4>删除持仓</h4></div>
      <button class="btn danger" onClick=${del}>${armed ? '再点一次确认删除' : '删除这只基金'}</button>
    </div>`;
}

export function FundDetail({ row, intraday, tab: initialTab, onClose, onChanged, onDeleted }) {
  const [tab, setTab] = useState(TABS.some((t) => t.value === initialTab) ? initialTab : 'overview');
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [ledger, setLedger] = useState(null);
  const loadLedger = () => api(`/holdings/${row.id}/ledger`).then((r) => setLedger(r.ledger)).catch(() => setLedger([]));
  useEffect(() => {
    fundDetail(row.code, true).then(setDetail).catch((e) => setErr(e.message));
    if (row.dcaCfg) loadLedger();
    else setLedger([]);
  }, [row.code]);
  const sub = html`<span class="num">${row.code}</span>${kindTag(row) ? html`<span class="tag">${kindTag(row)}</span>` : null}
    <span>${row.type || ''}</span>${detail?.meta?.buyStatus && detail.meta.buyStatus !== '开放申购' ? html`<span class="tag warn">${detail.meta.buyStatus}</span>` : null}`;
  return html`<${Drawer} title=${row.name} sub=${sub} onClose=${onClose} width=${700}>
    <${KeyFigures} row=${row} />
    <nav class="tabs">${TABS.map((t) => html`<button class=${tab === t.value ? 'on' : ''} onClick=${() => setTab(t.value)}>${t.label}</button>`)}</nav>
    ${err ? html`<div class="callout warn">${err}</div>` : null}
    ${tab === 'overview' ? html`<${Overview} row=${row} detail=${detail} intraday=${intraday} ledger=${ledger} />` : null}
    ${tab !== 'overview' && !detail && !err ? html`<${Loading} text="读取基金资料" />` : null}
    ${tab === 'est' && detail ? html`<${EstimateTab} row=${row} detail=${detail} onChanged=${onChanged} />` : null}
    ${tab === 'dca' && detail ? html`<${DcaTab} row=${row} detail=${detail} ledger=${ledger} reloadLedger=${loadLedger} onChanged=${onChanged} />` : null}
    ${tab === 'top' && detail ? html`<${TopTab} row=${row} detail=${detail} />` : null}
    ${tab === 'edit' && detail ? html`<${EditTab} row=${row} detail=${detail} onChanged=${onChanged} onDeleted=${onDeleted} />` : null}
  </${Drawer}>`;
}

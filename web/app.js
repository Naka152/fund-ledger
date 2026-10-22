import { html, render, useCallback, useEffect, useMemo, useRef, useState } from './vendor/preact-htm.js';
import { AccountBlock, AdminBlock, Login } from './js/account.js';
import { AddFund } from './js/add.js';
import { api } from './js/api.js';
import { IntradayChart } from './js/charts.js';
import { FavDetail, FundDetail } from './js/detail.js';
import { FavEmpty, FavList, GroupBar, GroupManager } from './js/lists.js';
import { TrendView } from './js/trend.js';
import { estLabel, hms, kindTag, md, money, weekday, when, ymd } from './js/fmt.js';
import { Drawer, InstrumentPicker, Loading, Num, Seg, Toaster, toast } from './js/ui.js';

const store = {
  get: (k, d) => {
    try {
      return localStorage.getItem('fl.' + k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem('fl.' + k, v);
    } catch {
      /* 隐私模式等情况下忽略 */
    }
  },
};

// ---------- 路由（hash），抽屉可以用浏览器返回键关闭 ----------
function useRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    addEventListener('hashchange', f);
    addEventListener('popstate', f);
    return () => {
      removeEventListener('hashchange', f);
      removeEventListener('popstate', f);
    };
  }, []);
  // 自己打开的抽屉在历史记录里做标记，关闭时退回；直接用链接打开的则原地清掉 hash
  const open = useCallback((h) => {
    if (history.state?.fl) history.replaceState({ fl: 1 }, '', h);
    else history.pushState({ fl: 1 }, '', h);
    setHash(h);
  }, []);
  const close = useCallback(() => {
    if (history.state?.fl) history.back();
    else {
      history.replaceState(null, '', location.pathname + location.search);
      setHash('');
    }
  }, []);
  const parts = hash.replace(/^#\/?/, '').split('/');
  return { name: parts[0] || '', arg: parts[1], tab: parts[2], open, close };
}

// ---------- 数据轮询：有市场开盘时 15 秒，否则 60 秒；页面隐藏时暂停 ----------
function usePortfolio() {
  const [state, setState] = useState({ data: null, err: null, busy: false, at: null });
  const timer = useRef();
  const last = useRef(null);
  const loadRef = useRef();
  const load = useCallback(async () => {
    clearTimeout(timer.current);
    setState((s) => ({ ...s, busy: true }));
    try {
      const d = await api('/portfolio');
      last.current = d;
      setState({ data: d, err: null, busy: false, at: new Date() });
    } catch (e) {
      setState((s) => ({ ...s, busy: false, err: e.status === 401 ? null : e.message }));
    }
    const open = last.current?.markets?.some((m) => m.state === 'open');
    timer.current = setTimeout(function tick() {
      if (document.hidden) timer.current = setTimeout(tick, 4000);
      else loadRef.current();
    }, open ? 15000 : 60000);
  }, []);
  loadRef.current = load;
  useEffect(() => {
    load();
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return { ...state, reload: load };
}

function useIntraday(at) {
  const [pts, setPts] = useState(null);
  const lastFetch = useRef(0);
  useEffect(() => {
    if (Date.now() - lastFetch.current < 55000) return;
    lastFetch.current = Date.now();
    api('/intraday')
      .then((r) => setPts(r.points || []))
      .catch(() => {});
  }, [at]);
  return pts;
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ---------- 页面结构 ----------
function Masthead({ data, at, busy, err, reload, onSettings, user }) {
  const now = useClock();
  return html`<header class="mast">
    <div class="brand"><h1>基金记账簿</h1><small>FUND LEDGER</small></div>
    <div class="mast-meta">
      <span class="clock">${ymd(now)} ${weekday(now)} ${hms(now)}</span>
      <span class="mkts">
        ${(data?.markets || []).map((m) => html`<span class=${`mkt ${m.state}`} title=${m.label}><i></i><b>${m.name}</b>${m.label}</span>`)}
      </span>
      <button class=${`tool ${busy ? 'spin' : ''}`} onClick=${reload} title="立即刷新">
        <span class="glyph">↻</span>${err ? html`<span class="err-line">${err}</span>` : at ? `更新于 ${hms(at)}` : '载入中'}
      </button>
      <button class="tool" onClick=${onSettings}>${user?.username ? user.username + ' · ' : ''}设置</button>
    </div>
  </header>`;
}

function Summary({ t, intraday, group, onExpand }) {
  // 全部：组合总值；某个分组：该分组自己的估值（新记录里按分组存了 [估算值, 净值]）
  const pts = group ? (intraday || []).filter((p) => p.g?.[group.id]) : intraday;
  const first = pts && pts.length ? pts[0] : null;
  const base = first ? (group ? first.g[group.id][1] : first.b) : null;
  const val = (p) => (base == null ? null : (group ? p.g[group.id][0] : p.v) - base);
  return html`<section class="summary">
    <div class="fig">
      <div class="fig-label"><span>实时估算 · ${group ? group.name : '总资产'}</span><span class="en">${group && !group.inTotal ? '不计入总资产' : 'ESTIMATED'}</span></div>
      <div class="fig-big"><span class="cur">¥</span><${Num} v=${t.estValue} /></div>
      <div class="fig-sub">
        <span>较最新净值</span><${Num} v=${t.estDayPnl} sign color /><${Num} v=${t.estDayPct} kind="pct" color />
      </div>
    </div>
    <div class="fig">
      <div class="fig-label"><span>按最新净值</span><span class="en">NAV</span></div>
      <div class="fig-mid"><${Num} v=${t.value} /></div>
      <div class="fig-sub">
        <span>最新一日</span><${Num} v=${t.dayPnl} sign color />
        ${t.pending > 0 ? html`<span>含在途 ${money(t.pending)}</span>` : null}
      </div>
    </div>
    <div class="fig">
      <div class="fig-label"><span>持有收益</span><span class="en">P&L</span></div>
      <div class="fig-mid"><${Num} v=${t.pnl} sign color /></div>
      <div class="fig-sub"><${Num} v=${t.pnlPct} kind="pct" color /><span>估算</span><${Num} v=${t.estPnl} sign color /></div>
    </div>
    <div class="fig fig-chart expandable" role="button" tabindex="0" title="点击放大，查看更长时间的走势"
      onClick=${onExpand} onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onExpand())}>
      <div class="fig-label"><span>今日估值走势</span><span class="en">放大 ⤢</span></div>
      <${IntradayChart} points=${pts} value=${val} height=${96} />
    </div>
  </section>`;
}

function WatchStrip({ watch, onEdit }) {
  return html`<div class="strip-wrap">
    <div class="strip">
      ${watch.map(
        (w) => html`<div class="strip-item" title=${w.id}>
          <div class="strip-name">${w.name}</div>
          <div class="strip-val"><${Num} v=${w.price} dec=${w.price > 1000 ? 2 : w.price > 10 ? 2 : 4} /><${Num} v=${w.pct} kind="pct" color /></div>
        </div>`,
      )}
      ${!watch.length ? html`<div class="strip-item muted">未设置关注指数</div>` : null}
    </div>
    <button class="strip-edit" onClick=${onEdit}>编辑指数</button>
  </div>`;
}

function estView(r, today) {
  const e = r.est || {};
  if (r.error) return { pct: null, nav: null, note: r.error };
  if (!e.mode || e.mode === 'none') return { pct: null, nav: null, note: '不估算' };
  if (e.error) return { pct: null, nav: null, note: e.error };
  if (!e.live) return { pct: null, nav: null, note: r.navDate === today ? '今日净值已更新' : '暂无新行情' };
  return { pct: e.estPct, nav: e.estNav, note: when(e.src?.ts) };
}

function dcaTag(r) {
  const d = r.dcaCfg;
  if (!d || !d.on) return null;
  const unit = { daily: '日', weekly: '周', biweekly: '两周', monthly: '月' }[d.freq] || '';
  return html`<span class="tag">定投 ${money(d.amount, { dec: d.amount % 1 ? 2 : 0 })}/${unit}</span>`;
}

const SORTS = [
  { value: 'manual', label: '默认' },
  { value: 'est', label: '估算涨跌' },
  { value: 'value', label: '金额' },
  { value: 'pnl', label: '收益率' },
];

function sortRows(rows, by) {
  const k = { est: (r) => r.est?.live ? r.est.estPct : -1e9, value: (r) => r.estValue ?? 0, pnl: (r) => r.pnlPct ?? -1e9 }[by];
  return k ? [...rows].sort((a, b) => k(b) - k(a)) : rows;
}

function Holdings({ rows, today, onOpen, groupName }) {
  return html`
    <table class="tbl">
      <thead><tr>
        <th>基金 · 估算依据</th><th>最新净值</th><th>估算净值</th><th>估算涨跌</th>
        <th>持有金额</th><th>估算盈亏</th><th>持有收益</th>
      </tr></thead>
      <tbody>
        ${rows.map((r) => {
          const ev = estView(r, today);
          return html`<tr class="row" key=${r.id} onClick=${() => onOpen(r.id)}>
            <td><div class="fund-cell">
              <div class="fund-name">${r.name}</div>
              <div class="fund-meta"><span class="code">${r.code}</span>${kindTag(r) && html`<span class="tag">${kindTag(r)}</span>`}
                <span class="src-line">${estLabel(r.est)}</span>${dcaTag(r)}${groupName ? groupName(r) : null}</div>
            </div></td>
            <td><div class="cell-main"><${Num} v=${r.nav} kind="nav" /></div>
              <div class="cell-sub">${md(r.navDate)} <${Num} v=${r.navPct} kind="pct" color /></div></td>
            <td><div class="cell-main">${ev.nav != null ? html`<${Num} v=${ev.nav} kind="nav" />` : html`<span class="muted">—</span>`}</div>
              <div class="cell-sub">${ev.note}</div></td>
            <td><div class="cell-big"><${Num} v=${ev.pct} kind="pct" color /></div>
              ${r.est?.src?.pct != null && r.est.live
                ? html`<div class="cell-sub">${r.est.mode === 'holdings' ? '持仓' : '标的'} <${Num} v=${r.est.src.pct} kind="pct" /></div>`
                : null}</td>
            <td><div class="cell-main"><${Num} v=${r.value} /></div>
              <div class="cell-sub">${r.pending > 0 ? html`在途 ${money(r.pending)}` : html`${money(r.shares)} 份`}</div></td>
            <td><div class="cell-main"><${Num} v=${r.estDayPnl} sign color /></div>
              <div class="cell-sub">最新日 <${Num} v=${r.dayPnl} sign color /></div></td>
            <td><div class="cell-main"><${Num} v=${r.pnl} sign color /></div>
              <div class="cell-sub"><${Num} v=${r.pnlPct} kind="pct" color /></div></td>
          </tr>`;
        })}
      </tbody>
    </table>
    <div class="cards">
      ${rows.map((r) => {
        const ev = estView(r, today);
        return html`<button type="button" class="card" key=${r.id} onClick=${() => onOpen(r.id)}>
          <div>
            <div class="fund-name">${r.name}</div>
            <div class="fund-meta"><span class="code">${r.code}</span>${kindTag(r) && html`<span class="tag">${kindTag(r)}</span>`}<span>${estLabel(r.est)}</span></div>
          </div>
          <div>
            <div class="pct-big">${ev.pct != null ? html`<${Num} v=${ev.pct} kind="pct" color />` : html`<span class="muted small">${ev.note}</span>`}</div>
            <div class="right-sub">${ev.nav != null ? html`估 <${Num} v=${ev.nav} kind="nav" />` : html`净值 <${Num} v=${r.nav} kind="nav" />`}</div>
          </div>
          <div class="card-figs">
            <div><span>持有金额</span><${Num} v=${r.estValue} /></div>
            <div><span>估算盈亏</span><${Num} v=${r.estDayPnl} sign color /></div>
            <div><span>持有收益</span><${Num} v=${r.pnl} sign color /></div>
          </div>
        </button>`;
      })}
    </div>`;
}

function Empty({ onAdd }) {
  return html`<div class="empty">
    <h3>还没有持仓</h3>
    <p>打开支付宝、天天基金等平台的基金持仓页，逐只点进基金，照着页面上的数字录入：</p>
    <ol>
      <li>搜索基金名称或代码</li>
      <li>填「持有份额」和「持仓成本价」（也可以填持有金额和持有收益）</li>
      <li>有定投的话顺手填上每期金额和费率</li>
    </ol>
    <button class="btn primary" onClick=${onAdd}>＋ 添加第一只基金</button>
  </div>`;
}

function WatchEditor({ watch, onClose, onSaved }) {
  const [list, setList] = useState(watch.map((w) => ({ id: w.id, name: w.name })));
  const [saving, setSaving] = useState(false);
  const move = (i, d) => {
    const l = [...list];
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    setList(l);
  };
  const save = async () => {
    setSaving(true);
    try {
      await api('/watch', { method: 'PUT', body: { ids: list.map((x) => x.id) } });
      onSaved();
      onClose();
    } catch (e) {
      toast(e.message, 'error');
      setSaving(false);
    }
  };
  return html`<${Drawer} title="关注的指数" sub="显示在总览下方的指数条" width=${520} onClose=${onClose}
    footer=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" disabled=${saving} onClick=${save}>保存</button>`}>
    <div class="block">
      <div class="watch-list">
        ${list.map((w, i) => html`<div class="watch-row" key=${w.id}>
          <span>${w.name} <span class="muted small num">${w.id}</span></span>
          <button class="icon-btn" aria-label="上移" onClick=${() => move(i, -1)}>↑</button>
          <button class="icon-btn" aria-label="下移" onClick=${() => move(i, 1)}>↓</button>
          <button class="icon-btn" aria-label="移除" onClick=${() => setList(list.filter((x) => x.id !== w.id))}>×</button>
        </div>`)}
      </div>
    </div>
    <div class="block">
      <div class="block-title"><h4>添加</h4><span class="muted small">罗素、MSCI 等用跟踪 ETF 代理</span></div>
      <${InstrumentPicker} onPick=${(it) => !list.some((x) => x.id === it.id) && setList([...list, { id: it.id, name: it.name }])} />
    </div>
  </${Drawer}>`;
}

function Settings({ auth, user, onClose }) {
  const [theme, setTheme] = useState(store.get('theme', 'auto'));
  const [up, setUp] = useState(store.get('up', 'red'));
  const applyTheme = (v) => {
    setTheme(v);
    store.set('theme', v);
    if (v === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', v);
  };
  const applyUp = (v) => {
    setUp(v);
    store.set('up', v);
    document.documentElement.setAttribute('data-up', v);
  };
  return html`<${Drawer} title="设置" width=${560} onClose=${onClose}>
    <${AccountBlock} user=${user} auth=${auth} />
    ${auth && user?.admin ? html`<${AdminBlock} me=${user} />` : null}
    <div class="block">
      <${FieldRow} label="外观"><${Seg} options=${[{ value: 'auto', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} value=${theme} onChange=${applyTheme} /></${FieldRow}>
      <${FieldRow} label="涨跌颜色"><${Seg} options=${[{ value: 'red', label: '红涨绿跌' }, { value: 'green', label: '绿涨红跌' }]} value=${up} onChange=${applyUp} /></${FieldRow}>
    </div>
    <div class="block note">
      <div class="block-title"><h4>估算是怎么算的</h4></div>
      <p><b>估算净值 = 最新净值 × (1 + 仓位系数 × 标的涨跌)</b>。标的涨跌从“最新净值那天的收盘价”算起，
      QDII 净值晚一两天公布时会自动把中间几天的涨跌连乘进去；海外标的再乘上人民币中间价的变化。</p>
      <p>指数基金默认跟踪自己的指数（仓位系数取业绩基准里的比例，通常 0.95）；主动基金默认用最近一期季报的前十大重仓股加权，
      再按股票仓位缩放；你也可以把任意基金链接到某个指数或 ETF，在基金详情的「估算」里还能看到这种估算方式过去 60 个净值日的误差。</p>
      <p>基金公司公布净值后，一律以公布的净值为准，估算只作参考。</p>
    </div>
    <div class="block note">
      <div class="block-title"><h4>持仓快照与定投</h4></div>
      <p>录入持仓时记下的是当时平台持仓页的快照。本站按录入时间判断快照对应哪天的净值，以及哪些定投扣款已经确认进了份额
      （普通基金 T+1 确认，QDII 通常 T+2）；之后的扣款由本站按当天净值和费率自动累计份额。</p>
    </div>
  </${Drawer}>`;
}

function FieldRow({ label, children }) {
  return html`<div class="field"><div class="field-label"><span>${label}</span></div><div>${children}</div></div>`;
}

const FAV_SORTS = [
  { value: 'manual', label: '默认' },
  { value: 'est', label: '估算涨跌' },
  { value: 'm1', label: '近一月' },
];

function sortFavs(rows, by) {
  const k = { est: (r) => (r.est?.live ? r.est.estPct : -1e9), m1: (r) => r.m1 ?? -1e9 }[by];
  return k ? [...rows].sort((a, b) => k(b) - k(a)) : rows;
}

function Main({ auth, user }) {
  const route = useRoute();
  const { data, err, busy, at, reload } = usePortfolio();
  const intraday = useIntraday(at);
  const [sort, setSort] = useState(store.get('sort', 'manual'));
  const [favSort, setFavSort] = useState(store.get('favSort', 'manual'));
  // ?view=fav / ?view=hold 可以直接打开某个标签（方便收藏链接）
  const [view, setView] = useState(() => ({ fav: 'fav', hold: 'hold' })[new URLSearchParams(location.search).get('view')] || store.get('view', 'hold'));
  const [groupSel, setGroupSel] = useState(store.get('group', 'all'));
  const today = data ? data.now.slice(0, 10) : ymd();
  const groups = data?.groups || [];
  const group = groups.find((g) => g.id === groupSel) || null; // 选中的分组不存在了就回到「全部」
  const rows = useMemo(
    () => (data ? sortRows(data.holdings.filter((r) => !group || r.group === group.id), sort) : []),
    [data, sort, group?.id],
  );
  const favRows = useMemo(() => (data ? sortFavs(data.favs || [], favSort) : []), [data, favSort]);
  const favCodes = new Set((data?.favs || []).map((f) => f.code));
  const heldCodes = new Set((data?.holdings || []).map((h) => h.code));
  const current = route.name === 'f' ? data?.holdings.find((h) => h.id === route.arg) : null;
  const currentFav = route.name === 'fav' ? data?.favs?.find((f) => f.code === route.arg) : null;
  const pref = (setter, key) => (v) => {
    setter(v);
    store.set(key, v);
  };
  const setSortP = pref(setSort, 'sort');
  const groupTag = !group && groups.length > 1
    ? (r) => {
        const g = groups.find((x) => x.id === r.group);
        return g ? html`<span class=${`tag ${g.inTotal ? '' : 'dim'}`}>${g.name}</span>` : null;
      }
    : null;
  const toggleFav = async (code) => {
    try {
      if (favCodes.has(code)) await api('/favs/' + code, { method: 'DELETE' });
      else await api('/favs', { method: 'POST', body: { code } });
      toast(favCodes.has(code) ? '已移出自选' : '已加入自选');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const removeFav = async (r) => {
    try {
      await api('/favs/' + r.code, { method: 'DELETE' });
      toast(`已移出自选：${r.name}`);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return html`<div class="wrap">
    <${Masthead} data=${data} at=${at} busy=${busy} err=${err} reload=${reload} user=${auth ? user : null} onSettings=${() => route.open('#/settings')} />
    ${!data
      ? html`<${Loading} text=${err || '正在读取持仓与行情'} />`
      : html`
        <${Summary} t=${group ? group.totals : data.totals} intraday=${intraday} group=${group} onExpand=${() => route.open('#/trend')} />
        <${WatchStrip} watch=${data.watch} onEdit=${() => route.open('#/watch')} />
        <div class="sec-head">
          <div class="sec-tabs" role="tablist">
            <button role="tab" aria-selected=${view === 'hold'} class=${view === 'hold' ? 'on' : ''} onClick=${() => pref(setView, 'view')('hold')}>
              <span class="sec-no">01</span>持仓<span class="sec-no">${data.holdings.length} 只</span></button>
            <button role="tab" aria-selected=${view === 'fav'} class=${view === 'fav' ? 'on' : ''} onClick=${() => pref(setView, 'view')('fav')}>
              <span class="sec-no">02</span>自选<span class="sec-no">${(data.favs || []).length} 只</span></button>
          </div>
          <div class="sec-tools">
            ${view === 'hold'
              ? html`${rows.length > 1 ? html`<${Seg} small options=${SORTS} value=${sort} onChange=${setSortP} label="排序" />` : null}
                  ${groups.length < 2 ? html`<button class="linkish small" onClick=${() => route.open('#/groups')}>分组</button>` : null}
                  <button class="btn primary" onClick=${() => route.open('#/add')}>＋ 添加基金</button>`
              : html`${favRows.length > 1 ? html`<${Seg} small options=${FAV_SORTS} value=${favSort} onChange=${pref(setFavSort, 'favSort')} label="排序" />` : null}
                  <button class="btn primary" onClick=${() => route.open('#/add/fav')}>＋ 添加自选</button>`}
          </div>
        </div>
        ${view === 'hold'
          ? html`${groups.length > 1
                ? html`<${GroupBar} groups=${groups} value=${group ? group.id : 'all'} total=${data.holdings.length}
                    onChange=${pref(setGroupSel, 'group')} onManage=${() => route.open('#/groups')} />`
                : null}
              ${rows.length
                ? html`<${Holdings} rows=${rows} today=${today} groupName=${groupTag} onOpen=${(id) => route.open('#/f/' + id)} />`
                : data.holdings.length
                  ? html`<div class="empty"><p>这个分组里还没有基金。添加基金时可以选择分组，也可以在持仓详情的「更新持仓」里改分组。</p></div>`
                  : html`<${Empty} onAdd=${() => route.open('#/add')} />`}`
          : favRows.length
            ? html`<${FavList} rows=${favRows} intraday=${intraday} heldCodes=${heldCodes} onOpen=${(code) => route.open('#/fav/' + code)} onRemove=${removeFav} />`
            : html`<${FavEmpty} onAdd=${() => route.open('#/add/fav')} />`}
      `}
    <footer class="foot">
      <p>估算仅供参考，一切以基金公司公布的净值为准。行情来自天天基金、东方财富、腾讯财经与 Yahoo Finance，
      港股行情可能有延迟；罗素、MSCI 等指数用跟踪 ETF 代理。</p>
      <span>基金记账簿 · ${today}</span>
    </footer>
    ${route.name === 'add' && data
      ? html`<${AddFund} key=${route.arg || 'hold'} mode=${route.arg === 'fav' ? 'fav' : 'hold'} presetCode=${route.arg === 'hold' ? route.tab : null}
          groups=${groups} defaultGroup=${group ? group.id : 'default'} favCodes=${[...favCodes]}
          onClose=${route.close} onAdded=${() => { reload(); route.close(); }} />`
      : null}
    ${route.name === 'f' && data
      ? current
        ? html`<${FundDetail} key=${current.id} row=${current} intraday=${intraday} tab=${route.tab} onClose=${route.close}
            groups=${groups} isFav=${favCodes.has(current.code)} onToggleFav=${() => toggleFav(current.code)}
            onChanged=${reload} onDeleted=${() => { reload(); route.close(); }} />`
        : html`<${Drawer} title="找不到这只持仓" onClose=${route.close}><p class="note pad">它可能已经被删除了。</p></${Drawer}>`
      : null}
    ${route.name === 'fav' && data
      ? currentFav
        ? html`<${FavDetail} key=${currentFav.code} row=${currentFav} intraday=${intraday} tab=${route.tab} held=${heldCodes.has(currentFav.code)}
            onClose=${route.close} onChanged=${reload} onRemoved=${() => { reload(); route.close(); }}
            onHold=${() => route.open('#/add/hold/' + currentFav.code)} />`
        : html`<${Drawer} title="不在自选里" onClose=${route.close}><p class="note pad">它可能已经被移出自选了。</p></${Drawer}>`
      : null}
    ${route.name === 'groups' && data ? html`<${GroupManager} groups=${groups} onClose=${route.close} onSaved=${reload} />` : null}
    ${route.name === 'trend' && data ? html`<${TrendView} portfolio=${data} group=${group} onClose=${route.close} />` : null}
    ${route.name === 'watch' && data ? html`<${WatchEditor} watch=${data.watch} onClose=${route.close} onSaved=${reload} />` : null}
    ${route.name === 'settings' ? html`<${Settings} auth=${auth} user=${user} onClose=${route.close} />` : null}
    <${Toaster} />
  </div>`;
}

function App() {
  const [session, setSession] = useState(null);
  useEffect(() => {
    api('/session')
      .then(setSession)
      .catch(() => setSession({ auth: true, user: null }));
    const f = () => setSession((s) => ({ ...(s || { auth: true }), user: null }));
    addEventListener('fl:unauthorized', f);
    return () => removeEventListener('fl:unauthorized', f);
  }, []);
  if (!session) return html`<div class="gate"><${Loading} /></div>`;
  if (session.auth && !session.user) {
    return html`<${Login} openSignup=${session.openSignup} onDone=${(user) => setSession({ ...session, user })} />`;
  }
  return html`<${Main} key=${session.user?.id} auth=${session.auth} user=${session.user} />`;
}

render(html`<${App} />`, document.getElementById('app'));

"""估值引擎。

估算净值 = 最新净值 × (1 + β × R)
R 为估算标的相对“净值日当天（或之前最近一天）收盘价”的人民币涨跌：
  · 标的在净值日之后还没有新交易日 → R = 0（最新净值已包含它的最新收盘）
  · 净值日与标的最新交易日之间没有其它工作日 → 基准价直接用昨收
  · 否则（QDII 净值滞后、节假日）从日 K 里找净值日当天或之前的收盘价，多日涨跌自动复合
  · 外币标的再乘以人民币中间价在同一区间的变化
β：指数基金取业绩基准中的指数比例（通常 95%），主动基金取最近一期股票仓位。
前十大持仓估算：用十大重仓的加权涨跌代表全部股票仓位。
"""
import math
import threading

import market
from util import BG, cache, s2d, weekdays_between

MODES = ('auto', 'index', 'holdings', 'link', 'none')
MODE_LABEL = {'index': '跟踪指数', 'holdings': '前十大持仓', 'link': '链接标的', 'none': '不估算'}


def cfg_of(h):
    return h.get('est') or {'mode': 'auto'}


def resolve_mode(h, meta):
    c = cfg_of(h)
    mode = c.get('mode') or 'auto'
    if mode == 'link' and (c.get('link') or {}).get('id'):
        return 'link'
    if mode == 'index' and meta.get('indexId'):
        return 'index'
    if mode == 'holdings' and meta.get('stocks'):
        return 'holdings'
    if mode == 'none':
        return 'none'
    if meta.get('indexId') and (meta.get('isIndex') or mode == 'index'):
        return 'index'
    if meta.get('stocks') and meta.get('kind') != 'money':
        return 'holdings'
    return 'none'


def default_beta(mode, meta):
    if mode == 'index':
        return meta.get('benchRatio') or meta.get('stockRatio') or 0.95
    if mode == 'link':
        return meta.get('stockRatio') or meta.get('benchRatio') or 0.9
    return meta.get('stockRatio') or 0.9


# 自动校准：用最近 60 个净值日拟合 β，相关性足够高时替代默认值。(最低相关系数, β 下限, β 上限)
FIT_RULES = {'index': (0.9, 0.7, 1.1), 'link': (0.5, 0.2, 1.6), 'holdings': (0.6, 0.3, 1.4)}
_fit_busy = set()
_fit_lock = threading.Lock()


def fit_key(h, meta):
    mode = resolve_mode(h, meta)
    src = 'top10' if mode == 'holdings' else ','.join(source_ids(h, meta))
    return f"{h['code']}|{mode}|{src}|{int(cfg_of(h).get('fx', True) is not False)}"


def fitted(h, meta):
    f = cache.fresh(('fit', fit_key(h, meta)))
    return f if f and f.get('beta') else None


def effective_beta(h, meta):
    """(β, 来源)：手动设置 > 历史拟合 > 默认（业绩基准比例 / 股票仓位）。"""
    c = cfg_of(h)
    if c.get('beta'):
        return c['beta'], 'manual'
    mode = resolve_mode(h, meta)
    f = fitted(h, meta)
    if f:
        return f['beta'], 'fit'
    return default_beta(mode, meta), 'default'


def schedule_fit(h, meta, navs):
    mode = resolve_mode(h, meta)
    if mode not in FIT_RULES or cfg_of(h).get('beta') or len(navs) < 25:
        return
    key = fit_key(h, meta)
    with _fit_lock:
        if cache.fresh(('fit', key)) is not None or key in _fit_busy:
            return
        _fit_busy.add(key)

    def job():
        try:
            bt = backtest(h, meta, navs, n=60) or {}
            lo_corr, lo, hi = FIT_RULES[mode]
            ok = bt.get('n', 0) >= 20 and bt.get('betaFit') and (bt.get('corr') or 0) >= lo_corr
            res = {'beta': round(min(hi, max(lo, bt['betaFit'])), 4) if ok else None,
                   'corr': bt.get('corr'), 'n': bt.get('n'), 'raw': bt.get('betaFit')}
            cache.set(('fit', key), res, 12 * 3600)
        except Exception:  # noqa: BLE001
            cache.set(('fit', key), {'beta': None}, 1800)
        finally:
            with _fit_lock:
                _fit_busy.discard(key)
    BG.submit(job)


def source_ids(h, meta):
    mode = resolve_mode(h, meta)
    if mode == 'index':
        return [meta['indexId']]
    if mode == 'link':
        return [cfg_of(h)['link']['id']]
    if mode == 'holdings':
        return [s['id'] for s in meta.get('stocks') or []]
    return []


def needs_kline(q, d0):
    return bool(q and q.get('date') and q['date'] > d0 and
                (not q.get('prev') or weekdays_between(s2d(d0), s2d(q['date']))))


def inst_return(iid, d0, qmap):
    q = qmap.get(iid)
    if not q or q.get('price') is None:
        return None
    qd = q.get('date')
    if not qd or qd <= d0:
        return {'r': 0.0, 'live': False, 'date': qd, 'q': q}
    if needs_kline(q, d0):
        try:
            kl = market.kline(iid)
        except Exception:  # noqa: BLE001
            kl = None
        base = market.close_on_or_before(kl, d0) or q.get('prev')
    else:
        base = q['prev']
    if not base:
        return None
    return {'r': q['price'] / base - 1, 'live': True, 'date': qd, 'q': q, 'base': base}


def _fx(iid, rr, d0, qmap, fx_on):
    ccy = market.market_of(iid)[1]
    if not fx_on or ccy == 'CNY' or not rr['live']:
        return 1.0, ccy
    return market.fx_ratio(ccy, d0, rr['date'], qmap), ccy


def estimate(h, meta, nav0, d0, qmap):
    c = cfg_of(h)
    mode = resolve_mode(h, meta)
    res = {'mode': mode, 'cfgMode': c.get('mode') or 'auto', 'label': MODE_LABEL.get(mode),
           'estNav': None, 'estPct': None, 'live': False, 'target': None}
    if mode == 'none' or not nav0 or not d0:
        return res
    fx_on = c.get('fx', True) is not False
    beta, beta_src = effective_beta(h, meta)
    parts = None
    if mode in ('index', 'link'):
        iid = meta['indexId'] if mode == 'index' else c['link']['id']
        name = meta.get('indexLabel') if mode == 'index' else (c['link'].get('name') or iid)
        rr = inst_return(iid, d0, qmap)
        if rr is None:
            res['error'] = '估算标的暂无行情'
            return res
        fxr, ccy = _fx(iid, rr, d0, qmap, fx_on)
        R = (1 + rr['r']) * fxr - 1
        q = rr['q']
        src = {'id': iid, 'name': name, 'price': q['price'], 'dayPct': q.get('pct'), 'pct': rr['r'] * 100,
               'date': rr['date'], 'ts': q.get('ts'), 'live': rr['live'], 'ccy': ccy,
               'fxPct': (fxr - 1) * 100 if fxr != 1.0 else None,
               'via': meta.get('indexVia') if mode == 'index' else 'link'}
    else:
        acc = wsum = 0.0
        parts, dates, tss, live = [], [], [], False
        for s in meta.get('stocks') or []:
            rr = inst_return(s['id'], d0, qmap)
            p = {'id': s['id'], 'code': s['code'], 'name': s['name'], 'weight': s['weight'],
                 'pct': None, 'dayPct': None, 'price': None}
            if rr is not None:
                fxr, _ = _fx(s['id'], rr, d0, qmap, fx_on)
                r = (1 + rr['r']) * fxr - 1
                acc += s['weight'] * r
                wsum += s['weight']
                p.update(pct=r * 100, dayPct=rr['q'].get('pct'), price=rr['q']['price'])
                p['_r'] = r
                live = live or rr['live']
                if rr['date']:
                    dates.append(rr['date'])
                if rr['q'].get('ts'):
                    tss.append(rr['q']['ts'])
            parts.append(p)
        if not wsum:
            res['error'] = '持仓股暂无行情'
            return res
        R = acc / wsum
        for p in parts:
            r = p.pop('_r', None)
            p['contrib'] = beta * p['weight'] * r / wsum * 100 if r is not None else None
        src = {'name': '前十大持仓', 'coverage': wsum, 'date': max(dates) if dates else None,
               'ts': max(tss) if tss else None, 'live': live, 'pct': R * 100,
               'reportDate': meta.get('stocksDate')}
    est_pct = beta * R
    res.update(estNav=nav0 * (1 + est_pct), estPct=est_pct * 100, beta=beta, betaSrc=beta_src,
               betaDefault=default_beta(mode, meta), fit=cache.fresh(('fit', fit_key(h, meta))),
               src=src, parts=parts, live=src['live'], target=src['date'])
    return res


# ---------- 回测：用历史净值检验估算方式 ----------

def backtest_ids(h, meta):
    return source_ids(h, meta)


def backtest(h, meta, navs, n=60):
    """最近 n 个净值日：标的涨跌 vs 实际净值涨跌，给出相关系数、拟合 β 与估算误差。"""
    mode = resolve_mode(h, meta)
    if mode == 'none':
        return None
    c = cfg_of(h)
    fx_on = c.get('fx', True) is not False
    beta, beta_src = effective_beta(h, meta)
    if mode == 'holdings':
        comps = [(s['id'], s['weight']) for s in meta.get('stocks') or []]
    else:
        comps = [(source_ids(h, meta)[0], 1.0)]
    series = {}
    for iid, _ in comps:
        try:
            series[iid] = market.kline(iid)
        except Exception:  # noqa: BLE001
            series[iid] = None
    fxk = {}
    for iid, _ in comps:
        ccy = market.market_of(iid)[1]
        if fx_on and ccy != 'CNY' and ccy not in fxk:
            try:
                fxk[ccy] = market.fx_series(ccy)
            except Exception:  # noqa: BLE001
                fxk[ccy] = None
    rows = [r for r in navs if r[3] is not None][-(n + 1):]
    xs, ys, days = [], [], []
    for i in range(1, len(rows)):
        dp, d, y = rows[i - 1][0], rows[i][0], rows[i][3] / 100
        acc = wsum = 0.0
        for iid, w in comps:
            kl = series.get(iid)
            a, b = market.close_on_or_before(kl, dp), market.close_on_or_before(kl, d)
            if not a or not b:
                continue
            r = b / a - 1
            ccy = market.market_of(iid)[1]
            if ccy in fxk and fxk[ccy]:
                fa, fb = market.close_on_or_before(fxk[ccy], dp), market.close_on_or_before(fxk[ccy], d)
                if fa and fb:
                    r = (1 + r) * fb / fa - 1
            acc += w * r
            wsum += w
        if not wsum:
            continue
        x = acc / wsum
        xs.append(x)
        ys.append(y)
        days.append({'date': d, 'src': x * 100, 'est': beta * x * 100, 'actual': y * 100})
    k = len(xs)
    if k < 5:
        return {'n': k, 'mode': mode}
    mx, my = sum(xs) / k, sum(ys) / k
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    corr = sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None
    b0 = sum(x * y for x, y in zip(xs, ys)) / sum(x * x for x in xs) if any(xs) else None
    mae = sum(abs(beta * x - y) for x, y in zip(xs, ys)) / k * 100
    mae_fit = sum(abs(b0 * x - y) for x, y in zip(xs, ys)) / k * 100 if b0 is not None else None
    hit = sum(1 for x, y in zip(xs, ys) if (x >= 0) == (y >= 0)) / k
    return {'n': k, 'mode': mode, 'beta': beta, 'betaSrc': beta_src, 'betaFit': b0, 'corr': corr, 'mae': mae,
            'maeFit': mae_fit, 'hit': hit, 'days': days[-12:][::-1],
            'from': days[0]['date'], 'to': days[-1]['date']}

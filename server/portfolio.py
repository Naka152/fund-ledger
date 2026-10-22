"""持仓存储、定投台账与组合估值。

持仓来自支付宝的快照：份额 + 持仓成本价 + 快照时间。快照时间决定两件事：
  1. 快照对应的净值日（当时已公布的最新净值），用于“按金额录入”时换算份额；
  2. 哪些定投扣款已经包含在支付宝份额里：扣款日 T 的份额在 T 之后第 N 个交易日确认
     （普通基金 N=1，QDII 通常 N=2），确认日晚于快照日的扣款由本站继续累计。
"""
import bisect
import os
import re
import secrets
import threading
import time
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

import auth
import catalog
import estimate
import fundsrc
import market
import tradecal
from util import CN, DATA, cache, now_cn, pmap, read_json, s2d, write_json

ESTLOG = os.path.join(DATA, 'estlog.json')
_lock = threading.RLock()
_estlog = read_json(ESTLOG, {}) or {}
_estlog_saved = [time.time()]
FREQS = ('daily', 'weekly', 'biweekly', 'monthly')
DCA_PARAMS = ('amount', 'feeRate', 'freq', 'weekday', 'monthday')
DEFAULT_GROUP = 'default'
GROUP_ID_RE = re.compile(r'default|g[0-9a-f]{8}')
MAX_GROUPS = 30
MAX_FAVS = 120


def r2(x):
    return float(Decimal(str(x)).quantize(Decimal('0.01'), ROUND_HALF_UP))


# ---------- 状态 ----------

def _state_path(uid):
    return os.path.join(auth.user_dir(uid), 'state.json')


def load(uid):
    with _lock:
        st = read_json(_state_path(uid)) or {}
    st.setdefault('v', 1)
    st.setdefault('holdings', [])
    st.setdefault('watch', list(catalog.DEFAULT_WATCH))
    st.setdefault('prefs', {})
    st.setdefault('favs', [])
    groups = [g for g in st.get('groups') or [] if g.get('id')]
    if not any(g['id'] == DEFAULT_GROUP for g in groups):
        groups.insert(0, {'id': DEFAULT_GROUP, 'name': '默认分组', 'inTotal': True})
    st['groups'] = groups
    return st


def group_of(st, h):
    gid = h.get('group') or DEFAULT_GROUP
    return gid if any(g['id'] == gid for g in st['groups']) else DEFAULT_GROUP


def save(uid, st):
    with _lock:
        write_json(_state_path(uid), st)


def mutate(uid, fn):
    with _lock:
        st = load(uid)
        out = fn(st)
        save(uid, st)
    cache.drop(('portfolio', uid))
    return out


# ---------- 校验与默认值 ----------

def _num(v, lo=None, hi=None, name='数值'):
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f'{name}格式不对') from None
    if x != x or (lo is not None and x < lo) or (hi is not None and x > hi):
        raise ValueError(f'{name}超出范围')
    return x


def _date(v, name='日期'):
    if v in (None, ''):
        return None
    try:
        return date.fromisoformat(str(v)[:10]).isoformat()
    except ValueError:
        raise ValueError(f'{name}格式不对') from None


def snapshot_nav_date(code, at):
    """快照时刻支付宝显示的净值日：当时已公布的最新净值（取不到时用当前最新）。"""
    rows = fundsrc.navs(code)
    lat = fundsrc.latest([code]).get(code)
    if lat and (not rows or rows[-1][0] < lat['date']):
        rows = rows + [[lat['date'], lat['nav'], lat.get('acc'), lat.get('pct')]]
    if not rows:
        return None
    # 历史净值只知道日期不知道公布时刻：快照早于该净值日 15:00 的，肯定还看不到它。
    for r in reversed(rows):
        pub = datetime.combine(s2d(r[0]), datetime.min.time(), CN) + timedelta(hours=15)
        if pub <= at:
            return r[0]
    return rows[0][0]


def dca_default_start(snap_at, confirm_days):
    """快照里尚未包含的第一笔定投的扣款日。"""
    s = snap_at.date()
    n = max(1, int(confirm_days or 1))
    t = tradecal.prev_trading_day(s, n + 1)
    while tradecal.next_trading_day(t, n) <= s:
        t = tradecal.next_trading_day(t)
    return t


def norm_est(e):
    e = e or {}
    mode = e.get('mode') or 'auto'
    if mode not in estimate.MODES:
        raise ValueError('估算方式不对')
    link = e.get('link') or None
    if mode == 'link' and not (link and link.get('id')):
        raise ValueError('请选择要链接的指数或标的')
    beta = e.get('beta')
    return {
        'mode': mode,
        'link': {'id': str(link['id'])[:40], 'name': str(link.get('name') or link['id'])[:60]} if link else None,
        'beta': round(_num(beta, 0.05, 2, '仓位系数'), 4) if beta not in (None, '') else None,
        'fx': e.get('fx', True) is not False,
    }


def normalize_holding(d, old=None):
    h = dict(old or {})
    code = str(d.get('code', h.get('code', ''))).strip()
    if not re.fullmatch(r'\d{6}', code):
        raise ValueError('基金代码应为 6 位数字')
    h['code'] = code
    if 'name' in d:
        h['name'] = str(d['name'] or '')[:80]
    if 'shares' in d or 'shares' not in h:
        h['shares'] = round(_num(d.get('shares', 0), 0, 1e12, '份额'), 2)
    if 'cost' in d or 'cost' not in h:
        h['cost'] = round(_num(d.get('cost', 0), 0, 1e6, '成本价'), 4)
    if 'snapshotAt' in d or 'snapshotAt' not in h:
        at = d.get('snapshotAt')
        try:
            at = datetime.fromisoformat(at).astimezone(CN) if at else now_cn()
        except ValueError:
            raise ValueError('快照时间格式不对') from None
        h['snapshotAt'] = at.isoformat(timespec='seconds')
    if 'snapshotNavDate' in d:
        h['snapshotNavDate'] = _date(d['snapshotNavDate'], '快照净值日')
    if 'est' in d:
        h['est'] = norm_est(d['est'])
    if 'group' in d:
        gid = str(d['group'] or DEFAULT_GROUP)
        h['group'] = gid if GROUP_ID_RE.fullmatch(gid) else DEFAULT_GROUP
    if 'dca' in d:
        v = d['dca']
        if not v:
            h['dca'] = None
        else:
            freq = v.get('freq') or 'daily'
            if freq not in FREQS:
                raise ValueError('定投频率不对')
            old_dca = (old or {}).get('dca') or {}
            on = bool(v.get('on', True))
            paused = None
            if not on:  # 暂停后不再累计新的扣款；记住暂停的日期
                paused = (old_dca.get('pausedAt') if old_dca and not old_dca.get('on', True) else None) \
                    or now_cn().date().isoformat()
            nd = {
                'on': on,
                'pausedAt': paused,
                'amount': r2(_num(v.get('amount'), 0.01, 1e8, '定投金额')),
                'freq': freq,
                'weekday': int(_num(v.get('weekday', 0), 0, 4, '定投星期')),
                'monthday': int(_num(v.get('monthday', 1), 1, 28, '定投日期')),
                'feeRate': _num(v.get('feeRate', 0), 0, 0.05, '费率'),
                'start': _date(v.get('start'), '开始日期'),
                'end': _date(v.get('end'), '结束日期'),
                'skips': sorted({_date(x) for x in (v.get('skips') or []) if x})[:500],
                'frozen': list(old_dca.get('frozen') or []),
            }
            if old_dca.get('start') and any(old_dca.get(k) != nd[k] for k in DCA_PARAMS):
                # 计划改了：已经发生的扣款按旧金额/费率冻结，新参数从今天（15:00 以后从明天）起生效
                now = now_cn()
                cut = now.date() if now.hour < 15 else now.date() + timedelta(days=1)
                nd['frozen'] = _freeze(old_dca, cut)
                nd['start'] = max(cut, s2d(nd['start']) if nd['start'] else cut).isoformat()
            h['dca'] = nd
    if 'note' in d:
        h['note'] = str(d['note'] or '')[:200]
    h.setdefault('est', {'mode': 'auto', 'link': None, 'beta': None, 'fx': True})
    h.setdefault('dca', None)
    h.setdefault('group', DEFAULT_GROUP)
    return h


def create_holding(uid, d):
    h = normalize_holding(d)
    code = h['code']
    meta = fundsrc.meta(code)
    h['name'] = h.get('name') or meta['name']
    at = datetime.fromisoformat(h['snapshotAt'])
    if not h.get('snapshotNavDate'):
        h['snapshotNavDate'] = snapshot_nav_date(code, at)
    if h.get('dca') and not h['dca'].get('start'):
        h['dca']['start'] = dca_default_start(at, meta.get('confirmDays')).isoformat()
    h['id'] = 'h' + secrets.token_hex(5)
    h['createdAt'] = now_cn().isoformat(timespec='seconds')

    def add(st):
        h['group'] = group_of(st, h)
        st['holdings'].append(h)
        return h
    return mutate(uid, add)


def update_holding(uid, hid, d):
    def upd(st):
        for i, h in enumerate(st['holdings']):
            if h['id'] == hid:
                nh = normalize_holding(d, h)
                if 'snapshotAt' in d and 'snapshotNavDate' not in d:
                    nh['snapshotNavDate'] = snapshot_nav_date(nh['code'], datetime.fromisoformat(nh['snapshotAt']))
                if nh.get('dca') and not nh['dca'].get('start'):
                    # 重新同步了支付宝快照：快照已包含的扣款（含冻结的旧计划扣款）不再累计
                    meta = fundsrc.meta(nh['code'])
                    start = dca_default_start(datetime.fromisoformat(nh['snapshotAt']), meta.get('confirmDays')).isoformat()
                    nh['dca']['start'] = start
                    nh['dca']['frozen'] = [e for e in nh['dca'].get('frozen') or [] if e['date'] >= start]
                nh['group'] = group_of(st, nh)
                nh['updatedAt'] = now_cn().isoformat(timespec='seconds')
                st['holdings'][i] = nh
                return nh
        raise KeyError('持仓不存在')
    return mutate(uid, upd)


def delete_holding(uid, hid):
    def rm(st):
        n = len(st['holdings'])
        st['holdings'] = [h for h in st['holdings'] if h['id'] != hid]
        if len(st['holdings']) == n:
            raise KeyError('持仓不存在')
        return True
    return mutate(uid, rm)


def reorder(uid, ids):
    def ro(st):
        pos = {hid: i for i, hid in enumerate(ids)}
        st['holdings'].sort(key=lambda h: pos.get(h['id'], 1e9))
        return True
    return mutate(uid, ro)


def set_groups(uid, groups):
    """整体保存分组：改名、排序、是否计入总资产。删掉的分组里的持仓移到默认分组，默认分组不能删。"""
    clean, names, ids = [], set(), set()
    for g in (groups or [])[:MAX_GROUPS]:
        name = str(g.get('name') or '').strip()[:16]
        if not name:
            raise ValueError('分组名称不能为空')
        if name in names:
            raise ValueError(f'分组「{name}」重复了')
        gid = str(g.get('id') or '')
        if not GROUP_ID_RE.fullmatch(gid) or gid in ids:
            gid = 'g' + secrets.token_hex(4)
        names.add(name)
        ids.add(gid)
        clean.append({'id': gid, 'name': name, 'inTotal': g.get('inTotal', True) is not False})
    if DEFAULT_GROUP not in ids:
        clean.insert(0, {'id': DEFAULT_GROUP, 'name': '默认分组' if '默认分组' not in names else '默认分组 ', 'inTotal': True})

    def sg(st):
        keep = {g['id'] for g in clean}
        for h in st['holdings']:
            if h.get('group', DEFAULT_GROUP) not in keep:
                h['group'] = DEFAULT_GROUP
        st['groups'] = clean
        return clean
    return mutate(uid, sg)


def _check_code(code):
    code = str(code or '').strip()
    if not re.fullmatch(r'\d{6}', code):
        raise ValueError('基金代码应为 6 位数字')
    return code


def add_fav(uid, code):
    code = _check_code(code)
    meta = fundsrc.meta(code)

    def af(st):
        for f in st['favs']:
            if f['code'] == code:
                return f
        if len(st['favs']) >= MAX_FAVS:
            raise ValueError(f'自选最多 {MAX_FAVS} 只')
        f = {'code': code, 'name': meta['name'], 'est': {'mode': 'auto', 'link': None, 'beta': None, 'fx': True},
             'addedAt': now_cn().isoformat(timespec='seconds')}
        st['favs'].append(f)
        return f
    return mutate(uid, af)


def update_fav(uid, code, d):
    code = _check_code(code)

    def uf(st):
        for f in st['favs']:
            if f['code'] == code:
                if 'est' in d:
                    f['est'] = norm_est(d['est'])
                return f
        raise KeyError('不在自选里')
    return mutate(uid, uf)


def delete_fav(uid, code):
    code = _check_code(code)

    def df(st):
        n = len(st['favs'])
        st['favs'] = [f for f in st['favs'] if f['code'] != code]
        if len(st['favs']) == n:
            raise KeyError('不在自选里')
        return True
    return mutate(uid, df)


def reorder_favs(uid, codes):
    def ro(st):
        pos = {c: i for i, c in enumerate(codes)}
        st['favs'].sort(key=lambda f: pos.get(f['code'], 1e9))
        return True
    return mutate(uid, ro)


def set_watch(uid, ids):
    ids = [str(i)[:40] for i in ids if i][:24]

    def sw(st):
        st['watch'] = ids
        return ids
    return mutate(uid, sw)


# ---------- 定投 ----------

def dca_trade_dates(dca, start, end):
    freq = dca.get('freq') or 'daily'
    if freq == 'daily':
        return tradecal.trading_days(start, end)
    out = []
    if freq in ('weekly', 'biweekly'):
        wd, step = int(dca.get('weekday') or 0), 7 if freq == 'weekly' else 14
        d = start + timedelta(days=(wd - start.weekday()) % 7)
        while d <= end:
            out.append(tradecal.first_trading_on_or_after(d))
            d += timedelta(days=step)
    elif freq == 'monthly':
        md = min(max(int(dca.get('monthday') or 1), 1), 28)
        y, m = start.year, start.month
        while True:
            d = date(y, m, md)
            if d > end:
                break
            if d >= start:
                out.append(tradecal.first_trading_on_or_after(d))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return sorted({t for t in out if t <= end})


def dca_calc(amount, rate):
    """前端收费（外扣法）：净申购金额 = 申购金额 / (1 + 费率)。"""
    net = r2(amount / (1 + rate))
    return net, r2(amount - net)


def _plan_entries(dca, stop):
    """按计划参数生成 [start, stop] 内的扣款（尊重暂停与结束日期）。"""
    if not dca or not dca.get('start'):
        return []
    start = s2d(dca['start'])
    if dca.get('end'):
        stop = min(stop, s2d(dca['end']))
    if not dca.get('on', True):
        stop = min(stop, s2d(dca.get('pausedAt') or dca['start']) - timedelta(days=1))
    if start > stop:
        return []
    return [{'date': t.isoformat(), 'amount': dca['amount'], 'feeRate': dca.get('feeRate') or 0}
            for t in dca_trade_dates(dca, start, stop)]


def _freeze(old_dca, cut):
    """把旧计划在 cut 之前的扣款固定下来。"""
    out = {e['date']: e for e in old_dca.get('frozen') or []}
    for e in _plan_entries(old_dca, cut - timedelta(days=1)):
        out.setdefault(e['date'], e)
    return [out[k] for k in sorted(out)]


def dca_ledger(h, navs, now=None):
    dca = h.get('dca')
    if not dca or not dca.get('start'):
        return []
    now = now or now_cn()
    end = now.date() if now.hour >= 15 else now.date() - timedelta(days=1)  # 15:00 前今天这笔还算待扣款
    entries = {e['date']: e for e in dca.get('frozen') or [] if e['date'] <= end.isoformat()}
    for e in _plan_entries(dca, end):
        entries.setdefault(e['date'], e)
    dates = [r[0] for r in navs]
    navmap = {r[0]: r[1] for r in navs}
    skips = set(dca.get('skips') or [])
    out = []
    for ds in sorted(entries):
        src = entries[ds]
        amount = float(src['amount'])
        net, fee = dca_calc(amount, float(src.get('feeRate') or 0))
        e = {'date': ds, 'amount': amount, 'fee': fee, 'net': net}
        if ds in skips:
            e['status'] = 'skipped'
        else:
            i = bisect.bisect_left(dates, ds)
            if i < len(dates) and (s2d(dates[i]) - s2d(ds)).days <= 10:
                nd = dates[i]
                e.update(status='done', navDate=nd, nav=navmap[nd], shares=r2(net / navmap[nd]))
            else:
                e['status'] = 'pending'
        out.append(e)
    return out


def dca_next(h, now=None):
    dca = h.get('dca')
    if not dca or not dca.get('on') or not dca.get('start'):
        return None
    now = now or now_cn()
    today = now.date()
    start = max(s2d(dca['start']), today if now.hour < 15 else today + timedelta(days=1))
    end = start + timedelta(days=45)
    if dca.get('end'):
        end = min(end, s2d(dca['end']))
    ds = dca_trade_dates(dca, start, end) if start <= end else []
    return ds[0].isoformat() if ds else None


# ---------- 组合估值 ----------

def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:  # noqa: BLE001
        return None


def _log_estimate(code, est, d0, navs):
    """记下每个目标交易日最后一次估算，净值公布后对比实际涨跌。"""
    log = _estlog.setdefault(code, {})
    tgt = est.get('target')
    if est.get('live') and tgt and tgt > d0 and est.get('estPct') is not None:
        log[tgt] = {'est': round(est['estPct'], 4), 'base': d0}
        for k in sorted(log)[:-20]:
            log.pop(k, None)
    last = None
    for k in sorted(log, reverse=True):
        if k <= d0:
            ent = log[k]
            row = next((r for r in navs if r[0] == k), None)
            prev = next((r for r in reversed(navs) if r[0] < k), None)
            if row and prev and prev[0] == ent['base'] and row[3] is not None:
                last = {'date': k, 'est': ent['est'], 'actual': row[3]}
            break
    return last


def _flush_estlog():
    if time.time() - _estlog_saved[0] > 60:
        _estlog_saved[0] = time.time()
        write_json(ESTLOG, _estlog)


def compute(uid):
    """组合估值。同时到来的请求（页面轮询、盘中记录）共用一次计算结果。"""
    return cache.get(('portfolio', uid), 3, lambda: _compute(uid))


def _sum_rows(rows):
    tot = {k: 0.0 for k in ('value', 'estValue', 'cost', 'pnl', 'estPnl', 'dayPnl', 'estDayPnl', 'pending')}
    for r in rows:
        if r.get('error') and r.get('value') is None:
            continue
        for k in tot:
            tot[k] += r.get(k) or 0
    tot['value'] += tot['pending']
    tot['estValue'] += tot['pending']
    held_cost = tot['cost']
    tot['pnlPct'] = tot['pnl'] / held_cost * 100 if held_cost else None
    tot['estPnlPct'] = tot['estPnl'] / held_cost * 100 if held_cost else None
    base = tot['value'] - tot['pending']
    tot['estDayPct'] = tot['estDayPnl'] / base * 100 if base else None
    prev_base = base - tot['dayPnl']
    tot['dayPct'] = tot['dayPnl'] / prev_base * 100 if prev_base else None
    return tot


def _compute(uid):
    st = load(uid)
    now = now_cn()
    hs, favs = st['holdings'], st['favs']
    items = hs + favs  # 估算只需要 code 与 est，持仓和自选共用
    codes = list(dict.fromkeys(x['code'] for x in items))
    lat = fundsrc.latest(codes) if codes else {}
    metas = dict(zip(codes, pmap(lambda c: _safe(fundsrc.meta, c), codes)))
    navss = dict(zip(codes, pmap(lambda c: _safe(fundsrc.navs, c, (lat.get(c) or {}).get('date')), codes)))
    for c in codes:
        rows = navss.get(c) or []
        L = lat.get(c)
        if L and (not rows or rows[-1][0] < L['date']):
            rows = rows + [[L['date'], L['nav'], L.get('acc'), L.get('pct')]]
        navss[c] = rows

    ids = set(st.get('watch') or []) | {'124.HSTECH', '100.NDX100'}
    for x in items:
        ids |= set(estimate.source_ids(x, metas.get(x['code']) or {}))
    qmap = market.quotes(ids)

    # 预取需要日 K 的标的（QDII 净值滞后、假期后等）与外币中间价
    need_k, ccys = set(), set()
    for x in items:
        rows = navss.get(x['code'])
        if not rows:
            continue
        d0 = rows[-1][0]
        for i in estimate.source_ids(x, metas.get(x['code']) or {}):
            q = qmap.get(i)
            if estimate.needs_kline(q, d0):
                need_k.add(i)
            if q and market.market_of(i)[1] != 'CNY' and q.get('date') and q['date'] > d0:
                ccys.add(market.market_of(i)[1])
    jobs = [(market.kline, i) for i in need_k] + [(market.fx_series, c) for c in ccys]
    if jobs:
        pmap(lambda j: _safe(j[0], j[1]), jobs)

    rows_out = []
    for h in hs:
        r = _holding_row(h, metas.get(h['code']), navss.get(h['code']) or [], qmap, now)
        r['group'] = group_of(st, h)
        rows_out.append(r)
    fav_rows = [_fav_row(f, metas.get(f['code']), navss.get(f['code']) or [], qmap, now) for f in favs]
    _flush_estlog()
    market.flush_closes()

    in_total = {g['id'] for g in st['groups'] if g.get('inTotal', True)}
    tot = _sum_rows([r for r in rows_out if r['group'] in in_total])
    groups = []
    for g in st['groups']:
        mine = [r for r in rows_out if r['group'] == g['id']]
        groups.append({'id': g['id'], 'name': g['name'], 'inTotal': g.get('inTotal', True),
                       'count': len(mine), 'totals': _sum_rows(mine)})

    qd = {k: (qmap.get(i) or {}).get('date') for k, i in (('hk', '124.HSTECH'), ('us', '100.NDX100'))}
    qd = {k: s2d(v) for k, v in qd.items() if v}
    watch = []
    for i in st.get('watch') or []:
        q = qmap.get(i)
        watch.append({'id': i, 'name': catalog.name_of(i) or (q or {}).get('name') or i,
                      'price': (q or {}).get('price'), 'pct': (q or {}).get('pct'),
                      'date': (q or {}).get('date'), 'ts': (q or {}).get('ts')})
    return {
        'now': now.isoformat(timespec='seconds'), 'markets': tradecal.market_status(now, qd),
        'holdings': rows_out, 'totals': tot, 'groups': groups, 'favs': fav_rows,
        'watch': watch, 'prefs': st.get('prefs') or {},
    }


def _period_pct(navs, n):
    """最近 n 个净值日的涨跌（用日涨幅连乘，分红不会造成跳空）。"""
    acc, k = 1.0, 0
    for r in reversed(navs):
        if k >= n:
            break
        if r[3] is not None:
            acc *= 1 + r[3] / 100
            k += 1
    return (acc - 1) * 100 if k else None


def _fav_row(f, meta, navs, qmap, now):
    meta = meta or {}
    row = {'code': f['code'], 'name': meta.get('name') or f.get('name') or f['code'], 'kind': meta.get('kind'),
           'type': meta.get('type'), 'isQDII': meta.get('isQDII'), 'estCfg': f.get('est'),
           'addedAt': f.get('addedAt')}
    if not navs:
        row['error'] = '暂时取不到净值'
        return row
    d0, nav0 = navs[-1][0], navs[-1][1]
    est = estimate.estimate(f, meta, nav0, d0, qmap)
    estimate.schedule_fit(f, meta, navs)
    row.update({
        'nav': nav0, 'navDate': d0, 'navPct': navs[-1][3], 'est': est,
        'lastEst': _log_estimate(f['code'], est, d0, navs),
        'm1': _period_pct(navs, 21), 'm3': _period_pct(navs, 63), 'y1': _period_pct(navs, 250),
        'spark': [r[1] for r in navs[-64:]],
    })
    return row


def _holding_row(h, meta, navs, qmap, now):
    meta = meta or {}
    row = {'id': h['id'], 'code': h['code'], 'name': meta.get('name') or h.get('name') or h['code'],
           'kind': meta.get('kind'), 'type': meta.get('type'), 'isQDII': meta.get('isQDII'),
           'snapshotAt': h.get('snapshotAt'), 'snapshotNavDate': h.get('snapshotNavDate'),
           'estCfg': h.get('est'), 'dcaCfg': h.get('dca'), 'note': h.get('note'),
           'snapShares': h['shares'], 'snapCost': h['cost']}
    try:
        row['dcaSuggestStart'] = dca_default_start(
            datetime.fromisoformat(h['snapshotAt']), meta.get('confirmDays')).isoformat()
    except (KeyError, ValueError, TypeError):
        row['dcaSuggestStart'] = None
    if not navs:
        row['error'] = '暂时取不到净值'
        row.update(shares=h['shares'], cost=h['shares'] * h['cost'], value=None)
        return row
    d0, nav0 = navs[-1][0], navs[-1][1]
    prev = navs[-2] if len(navs) > 1 else None
    ledger = dca_ledger(h, navs, now)
    done = [e for e in ledger if e['status'] == 'done']
    shares = h['shares'] + sum(e['shares'] for e in done)
    cost = h['shares'] * h['cost'] + sum(e['amount'] for e in done)
    pending = sum(e['amount'] for e in ledger if e['status'] == 'pending')
    fresh_shares = sum(e['shares'] for e in done if e['navDate'] == d0)

    est = estimate.estimate(h, meta, nav0, d0, qmap)
    estimate.schedule_fit(h, meta, navs)
    last_est = _log_estimate(h['code'], est, d0, navs)
    est_nav = est['estNav'] or nav0
    value, est_value = shares * nav0, shares * est_nav
    day_pnl = (shares - fresh_shares) * (nav0 - prev[1]) if prev else 0.0

    row.update({
        'nav': nav0, 'navDate': d0, 'navPct': navs[-1][3], 'prevNav': prev[1] if prev else None,
        'prevNavDate': prev[0] if prev else None,
        'est': est, 'lastEst': last_est,
        'shares': shares, 'cost': cost, 'costPrice': cost / shares if shares else None,
        'value': value, 'estValue': est_value,
        'pnl': value - cost, 'pnlPct': (value - cost) / cost * 100 if cost else None,
        'estPnl': est_value - cost,
        'dayPnl': day_pnl, 'estDayPnl': est_value - value, 'pending': pending,
        'dca': {
            'count': len(done), 'invested': sum(e['amount'] for e in done),
            'shares': sum(e['shares'] for e in done), 'fees': sum(e['fee'] for e in done),
            'pendingCount': sum(1 for e in ledger if e['status'] == 'pending'),
            'next': dca_next(h, now),
        } if h.get('dca') else None,
        'spark': [r[1] for r in navs[-40:]],
    })
    return row


TREND_RANGES = {'1m': 22, '3m': 66, '6m': 130, '1y': 250}


def trend(uid, rng):
    """较长时间的走势：每只持仓按当前份额回溯每日市值（用日涨幅连乘，分红不跳空），最后一个点是实时估算。"""
    n = TREND_RANGES.get(rng, 22)
    res = compute(uid)
    rows = [r for r in res['holdings'] if r.get('value') is not None and r.get('shares')]
    hist = {}
    for r in rows:
        navs = _safe(fundsrc.navs, r['code'], r.get('navDate')) or []
        if navs and navs[-1][0] < r['navDate']:
            navs = navs + [[r['navDate'], r['nav'], None, r.get('navPct')]]
        if not navs:
            continue
        idx, acc = [], 1.0
        for i, row in enumerate(navs):
            if i:
                acc *= 1 + row[3] / 100 if row[3] is not None else row[1] / navs[i - 1][1]
            idx.append(acc)
        last = r['shares'] * navs[-1][1]
        hist[r['id']] = [(row[0], last * idx[i] / idx[-1]) for i, row in enumerate(navs)]
    dates = sorted({d for h in hist.values() for d, _ in h[-(n + 1):]})[-(n + 1):]
    live = any((r.get('est') or {}).get('live') for r in rows)
    groups = {g['id']: g for g in res['groups']}
    out = []
    for r in rows:
        h = hist.get(r['id'])
        if not h:
            continue
        hd = [d for d, _ in h]
        vals = []
        for d in dates:  # 用当天或之前最近一个净值日的市值（QDII 净值晚一天、假期不同步）
            i = bisect.bisect_right(hd, d)
            vals.append(round(h[i - 1][1], 2) if i else None)
        if live:
            vals.append(round(r['estValue'], 2))
        g = groups.get(r.get('group')) or {}
        out.append({'id': r['id'], 'code': r['code'], 'name': r['name'], 'group': r.get('group'),
                    'inTotal': g.get('inTotal', True), 'values': vals})
    return {'range': rng, 'dates': dates, 'est': live, 'now': res['now'], 'holdings': out}


def fund_detail(code, now=None):
    """添加/查看基金时用：资料、最新净值、近一年净值、估算预览与快照建议。"""
    now = now or now_cn()
    meta, lat, _ = pmap(lambda f: f(), [lambda: fundsrc.meta(code), lambda: fundsrc.latest([code]).get(code),
                                         lambda: fundsrc.navs(code)])
    if meta is None:
        meta = fundsrc.meta(code)  # 让“找不到基金”之类的错误原样抛出
    navs = fundsrc.navs(code, (lat or {}).get('date'))
    if lat and (not navs or navs[-1][0] < lat['date']):
        navs = navs + [[lat['date'], lat['nav'], lat.get('acc'), lat.get('pct')]]
    fake = {'id': '_', 'code': code, 'shares': 0, 'cost': 0, 'est': {'mode': 'auto'}}
    ids = estimate.source_ids(fake, meta)
    qmap = market.quotes(ids)
    est = estimate.estimate(fake, meta, navs[-1][1], navs[-1][0], qmap) if navs else None
    snap_date = snapshot_nav_date(code, now) if navs else None
    return {
        'meta': meta, 'navs': navs, 'est': est,
        'suggest': {
            'snapshotNavDate': snap_date,
            'dcaStart': dca_default_start(now, meta.get('confirmDays')).isoformat(),
            'feeRate': (meta.get('feeRate') or 0) / 100,
        },
    }

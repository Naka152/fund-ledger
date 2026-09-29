"""行情：实时报价、日 K 收盘价、证券搜索、汇率。

标的 ID 统一用东方财富 secid（1.000510、100.NDX100、107.IWF、116.00700），
雅虎财经标的用 yf: 前缀（yf:^RLG）。

海外服务器上东方财富的行情接口时常 502/断连，雅虎会限流，所以：
  实时报价：腾讯（A 股/港股/美股个股与 ETF、港美主要指数、全球指数）→ 东方财富 → 雅虎
  日 K：   腾讯（A 股/港股/美股）→ 东方财富 → 雅虎
  汇率：   中国外汇交易中心（人民币中间价，QDII 估值用的就是它）→ 东方财富 → 雅虎
出错的数据源会被熔断一段时间，失败结果也会短暂缓存，避免每次刷新都等超时。
"""
import bisect
import os
import re
import threading
import time
import urllib.parse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import catalog
from util import CACHE_DIR, breaker, cache, curl_json, fnum, get_json, get_text, iomap, now_cn, read_json, write_json

EM_HOSTS = ('http://push2delay.eastmoney.com', 'https://push2delay.eastmoney.com')
EM_KHOSTS = ('http://push2his.eastmoney.com', 'https://push2his.eastmoney.com')
EM_QUOTE = '/api/qt/ulist.np/get?fltt=2&invt=2&secids={}&fields=f2,f12,f13,f14,f18,f124'
EM_KLINE = ('/api/qt/stock/kline/get?secid={}&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=1'
            '&end=20500101&lmt={}')
EM_SEARCH = ('https://searchapi.eastmoney.com/api/suggest/get?input={}&type=14'
             '&token=D43BF722C8E33BDC906FB84D85E326E8&count={}')
TX_QUOTE = 'https://qt.gtimg.cn/q={}'
TX_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={},day,,,{},qfq'
YF_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/{}?range={}&interval=1d'
CM_ALL = ('https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew?startDate={}&endDate={}'
          '&pageNum=1&pageSize=80')  # 区间太长或每页太多会被拒绝（403）

TZ_CN, TZ_HK, TZ_US = 'Asia/Shanghai', 'Asia/Hong_Kong', 'America/New_York'
GLOBAL_IDX = {
    'HSI': (TZ_HK, 'HKD'), 'HSCEI': (TZ_HK, 'HKD'), 'N225': ('Asia/Tokyo', 'JPY'),
    'KS11': ('Asia/Seoul', 'KRW'), 'TWII': ('Asia/Taipei', 'TWD'), 'SENSEX': ('Asia/Kolkata', 'INR'),
    'AS51': ('Australia/Sydney', 'AUD'), 'VNINDEX': ('Asia/Ho_Chi_Minh', 'VND'),
    'GDAXI': ('Europe/Berlin', 'EUR'), 'FCHI': ('Europe/Paris', 'EUR'), 'SX5E': ('Europe/Berlin', 'EUR'),
    'AEX': ('Europe/Amsterdam', 'EUR'), 'FTSE': ('Europe/London', 'GBP'), 'SSMI': ('Europe/Zurich', 'CHF'),
    'BVSP': ('America/Sao_Paulo', 'BRL'), 'GSPTSE': ('America/Toronto', 'CAD'),
    'MXX': ('America/Mexico_City', 'MXN'), 'STI': ('Asia/Singapore', 'SGD'),
    'KLSE': ('Asia/Kuala_Lumpur', 'MYR'), 'SET': ('Asia/Bangkok', 'THB'), 'JKSE': ('Asia/Jakarta', 'IDR'),
    'PSI': ('Asia/Manila', 'PHP'), 'NZ50': ('Pacific/Auckland', 'NZD'),
}
# 腾讯行情代码：港美指数与全球指数（gz 前缀，时间为北京时间）
TX_SPECIAL = {
    '124.HSTECH': 'hkHSTECH', '100.HSI': 'hkHSI', '100.HSCEI': 'hkHSCEI', '124.HSCI': 'hkHSCI',
    '124.HSHCI': 'hkHSHCI', '100.NDX100': 'usNDX', '100.SPX': 'usINX', '100.DJIA': 'usDJI', '100.NDX': 'usIXIC',
    '100.N225': 'gzN225', '100.GDAXI': 'gzGDAXI', '100.FTSE': 'gzFTSE', '100.FCHI': 'gzFCHI',
    '100.SX5E': 'gzSX5E', '100.KS11': 'gzKS11', '100.TWII': 'gzTWII', '100.VNINDEX': 'gzVNINDEX',
}
TX_KSPECIAL = {'100.NDX100': 'us.NDX', '100.SPX': 'us.INX', '100.DJIA': 'us.DJI', '100.NDX': 'us.IXIC',
               '124.HSTECH': 'hkHSTECH', '100.HSI': 'hkHSI', '100.HSCEI': 'hkHSCEI'}
TX_US_SUFFIX = {'105': '.OQ', '106': '.N', '107': '.AM'}
YF_MAP = {
    '100.NDX100': '^NDX', '100.NDX': '^IXIC', '100.SPX': '^GSPC', '100.DJIA': '^DJI', '251.SOX': '^SOX',
    '100.HSI': '^HSI', '100.HSCEI': '^HSCE', '100.N225': '^N225', '100.KS11': '^KS11', '100.TWII': '^TWII',
    '100.SENSEX': '^BSESN', '100.AS51': '^AXJO', '100.GDAXI': '^GDAXI', '100.FCHI': '^FCHI',
    '100.SX5E': '^STOXX50E', '100.FTSE': '^FTSE', '100.BVSP': '^BVSP', '101.GC00Y': 'GC=F', '102.CL00Y': 'CL=F',
    '133.USDCNH': 'CNH=X',
}
# 人民币中间价（中国外汇交易中心）。CNY/XXX 形式的币种取倒数。
CM_PAIRS = {'USD': 'USD/CNY', 'EUR': 'EUR/CNY', 'JPY': '100JPY/CNY', 'HKD': 'HKD/CNY', 'GBP': 'GBP/CNY',
            'AUD': 'AUD/CNY', 'NZD': 'NZD/CNY', 'SGD': 'SGD/CNY', 'CHF': 'CHF/CNY', 'CAD': 'CAD/CNY',
            'MYR': 'CNY/MYR', 'KRW': 'CNY/KRW', 'THB': 'CNY/THB', 'MXN': 'CNY/MXN', 'SAR': 'CNY/SAR'}
FX_EM = {c: f'120.{c}CNYC' for c in ('USD', 'HKD', 'JPY', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'CHF')}
_YF_META = {}
_TX_US = {}

# 自存收盘价：每次取到报价都记下该交易日的最新价（收盘后即为收盘价），
# 在第三方日 K 取不到时（全球指数常见）补足历史。
CLOSES_PATH = os.path.join(CACHE_DIR, 'closes.json')
_closes = read_json(CLOSES_PATH, {}) or {}
_closes_lock = threading.Lock()
_closes_dirty = [0.0]


def _remember(q):
    if not q or not q.get('date') or not q.get('price'):
        return
    with _closes_lock:
        d = _closes.setdefault(q['id'], {})
        if d.get(q['date']) != q['price']:
            d[q['date']] = q['price']
            if len(d) > 420:
                for k in sorted(d)[:-400]:
                    d.pop(k, None)
            _closes_dirty[0] = _closes_dirty[0] or time.time()


def flush_closes(force=False):
    with _closes_lock:
        if _closes_dirty[0] and (force or time.time() - _closes_dirty[0] > 300):
            write_json(CLOSES_PATH, _closes)
            _closes_dirty[0] = 0.0


def stored_closes(iid):
    with _closes_lock:
        return sorted((_closes.get(iid) or {}).items())


def market_of(iid):
    """标的所在市场的 (时区, 币种)。"""
    if iid.startswith('yf:'):
        return _YF_META.get(iid[3:], (TZ_US, 'USD'))
    m, _, c = iid.partition('.')
    if m in ('116', '124', '128'):
        return TZ_HK, 'HKD'
    if m in ('105', '106', '107', '251', '101', '102', '103', '104', '108'):
        return TZ_US, 'USD'
    if m == '100':
        return GLOBAL_IDX.get(c, (TZ_US, 'USD'))
    return TZ_CN, 'CNY'


def fx_id(ccy):
    return FX_EM.get(ccy) or f'yf:{ccy}CNY=X'


def _is_bj(c):
    return c[:1] in '48' or c.startswith('92')


def tx_code(iid):
    if iid in TX_SPECIAL:
        return TX_SPECIAL[iid]
    m, _, c = iid.partition('.')
    if m == '1':
        return 'sh' + c
    if m == '0':
        return ('bj' if _is_bj(c) else 'sz') + c
    if m == '116':
        return 'r_hk' + c
    if m in ('105', '106', '107'):
        return 'us' + c
    return None


def tx_kcodes(iid):
    if iid in TX_KSPECIAL:
        return [TX_KSPECIAL[iid]]
    m, _, c = iid.partition('.')
    if m in TX_US_SUFFIX:
        out = ['us' + c + TX_US_SUFFIX[m]]
        if _TX_US.get(iid) and _TX_US[iid] not in out:
            out.append(_TX_US[iid])
        return out
    code = tx_code(iid)
    return [code.replace('r_hk', 'hk')] if code and not code.startswith('gz') else []


def yf_symbol(iid):
    if iid.startswith('yf:'):
        return iid[3:]
    if iid in YF_MAP:
        return YF_MAP[iid]
    m, _, c = iid.partition('.')
    if m in ('105', '106', '107'):
        return c.replace('.', '-')
    if m == '116':
        return c.lstrip('0').zfill(4) + '.HK'
    if m == '1':
        return c + '.SS'
    if m == '0':
        return c + ('.BJ' if _is_bj(c) else '.SZ')
    return None


def _local_date(ts, tz):
    return datetime.fromtimestamp(ts, ZoneInfo(tz)).date().isoformat()


def _mk(iid, name, price, prev, ts, src):
    tz, ccy = market_of(iid)
    if price is None or price <= 0:
        price = prev
    if price is None:
        return None
    return {
        'id': iid, 'name': name, 'price': price, 'prev': prev,
        'pct': (price / prev - 1) * 100 if prev else None,
        'ts': ts, 'date': _local_date(ts, tz) if ts else None, 'tz': tz, 'ccy': ccy, 'src': src,
    }


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:  # noqa: BLE001
        return None


def _ts(digits, tz):
    digits = re.sub(r'\D', '', digits or '')[:14]
    if len(digits) != 14:
        return None
    return datetime.strptime(digits, '%Y%m%d%H%M%S').replace(tzinfo=ZoneInfo(tz)).timestamp()


# ---------- 实时报价 ----------

def _tx_fetch(ids):
    codes = {tx_code(i): i for i in ids}
    text = get_text(TX_QUOTE.format(','.join(codes)), encoding='gbk', timeout=6, retries=0)
    out = {}
    for m in re.finditer(r'v_([\w.]+)="([^"]*)"', text):
        iid = codes.get(m.group(1))
        f = m.group(2).split('~')
        if not iid:
            continue
        if m.group(1).startswith('gz'):  # 全球指数：代码~名称~北京时间~现价~涨跌额~涨跌幅
            if len(f) < 6:
                continue
            price, chg = fnum(f[3]), fnum(f[4])
            prev = price - chg if price is not None and chg is not None else None
            q = _mk(iid, f[1], price, prev, _ts(f[2], TZ_CN), 'tx')
        else:
            if len(f) < 33:
                continue
            if iid.partition('.')[0] in TX_US_SUFFIX and f[2]:
                _TX_US[iid] = 'us' + f[2]
            q = _mk(iid, f[1], fnum(f[3]), fnum(f[4]), _ts(f[30], market_of(iid)[0]), 'tx')
        if q:
            out[iid] = q
    return out


def _em_get(hosts, path, timeout, name):
    if not breaker.ok(name):
        raise RuntimeError(f'{name} paused')
    last = None
    for h in hosts:
        try:
            return get_json(h + path, timeout=timeout, retries=0)
        except Exception as e:  # noqa: BLE001
            last = e
    breaker.trip(name, 180)
    raise last


def _em_fetch(ids):
    d = _em_get(EM_HOSTS, EM_QUOTE.format(','.join(ids)), 4, 'emq')
    out = {}
    for x in ((d.get('data') or {}).get('diff') or []):
        iid = f"{x['f13']}.{x['f12']}"
        q = _mk(iid, x.get('f14'), fnum(x.get('f2')), fnum(x.get('f18')), x.get('f124'), 'em')
        if q:
            out[iid] = q
    return out


def _yf_chart(sym, rng):
    if not breaker.ok('yf'):
        raise RuntimeError('yahoo paused')
    try:
        d = get_json(YF_CHART.format(urllib.parse.quote(sym), rng), timeout=5, retries=0)
    except Exception:
        breaker.trip('yf', 900)
        raise
    r = d['chart']['result'][0]
    m = r['meta']
    tz = m.get('exchangeTimezoneName') or TZ_US
    _YF_META[sym] = (tz, m.get('currency') or 'USD')
    closes = []
    for ts, c in zip(r.get('timestamp') or [], (r['indicators']['quote'][0].get('close') or [])):
        if c is not None:
            closes.append((_local_date(ts, tz), c))
    return m, closes


def _yf_one(iid):
    sym = yf_symbol(iid)
    m, closes = _yf_chart(sym, '5d')
    price, ts = m.get('regularMarketPrice'), m.get('regularMarketTime')
    tz = _YF_META[sym][0]
    qd = _local_date(ts, tz) if ts else None
    prev = next((c for d, c in reversed(closes) if qd and d < qd), None) or m.get('chartPreviousClose')
    q = _mk(iid, m.get('shortName') or sym, price, prev, ts, 'yf')
    if q and not iid.startswith('yf:'):
        q['tz'], q['ccy'] = market_of(iid)
        q['date'] = _local_date(ts, q['tz']) if ts else None
    return {iid: q} if q else {}


def _run(jobs):
    got = {}
    for res in iomap(lambda j: j[0](j[1]), jobs):
        if res:
            got.update(res)
    return got


def quotes(ids, ttl=5, parallel=True):  # noqa: ARG001 - parallel 保留兼容
    """批量实时报价 {id: quote}。取不到新数据时返回最近一次的旧值。"""
    ids = [i for i in dict.fromkeys(ids) if i]
    out, need = {}, []
    for i in ids:
        q = cache.fresh(('q', i))
        if q:
            out[i] = q
        else:
            need.append(i)
    if not need:
        return out
    tx = [i for i in need if tx_code(i)]
    yf = [i for i in need if i.startswith('yf:')]
    em = [i for i in need if i not in tx and i not in yf]
    jobs = [(_tx_fetch, tx[k:k + 60]) for k in range(0, len(tx), 60)]
    jobs += [(_em_fetch, em[k:k + 80]) for k in range(0, len(em), 80)]
    jobs += [(_yf_one, i) for i in yf]
    got = _run(jobs)
    miss = [i for i in tx if i not in got]
    if miss:
        got.update(_safe(_em_fetch, miss) or {})
    miss = [i for i in need if i not in got and not i.startswith('yf:') and yf_symbol(i)]
    if miss and breaker.ok('yf'):
        got.update(_run([(_yf_one, i) for i in miss[:8]]))
    for i, q in got.items():
        cache.set(('q', i), q, ttl)
        _remember(q)
    for i in need:
        q = got.get(i) or cache.peek(('q', i))
        if q:
            out[i] = q
    return out


# ---------- 日 K ----------

def _tx_kline(iid, n):
    for code in tx_kcodes(iid):
        d = get_json(TX_KLINE.format(code, n), timeout=6, retries=0)
        v = (d.get('data') or {}).get(code) if isinstance(d.get('data'), dict) else None
        rows = (v or {}).get('qfqday') or (v or {}).get('day') or []
        out = [(r[0], fnum(r[2])) for r in rows if len(r) > 2 and fnum(r[2])]
        if len(out) >= 2 and out[-1][1] < out[-2][1] * 0.2:  # 腾讯美股指数当天的临时 K 线偶有错值
            out.pop()
        if out:
            return out
    return None


def _yf_kline(iid, n):
    sym = yf_symbol(iid)
    if not sym:
        return None
    out = _yf_chart(sym, '1y' if n > 120 else '6mo')[1]
    return out[-n:] if len(out) >= 2 else None


def _em_kline(iid, n):
    d = _em_get(EM_KHOSTS, EM_KLINE.format(iid, n), 6, 'emk')
    out = []
    for s in ((d.get('data') or {}).get('klines') or []):
        p = s.split(',')
        c = fnum(p[1])
        if c:
            out.append((p[0], c))
    return out or None


def kline(iid, n=160):
    """日 K 收盘价 [(YYYY-MM-DD, close)]，按日期升序（股票为前复权）。取不到时返回 []（短暂缓存）。"""
    if iid.startswith('yf:'):
        chain = (_yf_kline,)
    elif tx_kcodes(iid):
        chain = (_tx_kline, _em_kline, _yf_kline)
    else:
        chain = (_em_kline, _yf_kline)

    def load():
        for fn in chain:
            out = _safe(fn, iid, n)
            if out:
                return out
        return []
    fetched = cache.get(('k', iid, n), lambda v: 3 * 3600 if v else 600, load)
    own = stored_closes(iid)
    if not own:
        return fetched
    merged = dict(own)
    merged.update(dict(fetched))  # 第三方日 K 优先，自存的只补缺
    return sorted(merged.items())[-n:]


def close_on_or_before(kl, dstr):
    if not kl:
        return None
    i = bisect.bisect_right([d for d, _ in kl], dstr)
    return kl[i - 1][1] if i else None


# ---------- 汇率 ----------

def _cm_table():
    """一次取回所有币种近 100 天的人民币中间价：{币对: [(date, value)]}。"""
    if not breaker.ok('cm'):
        raise RuntimeError('chinamoney paused')
    today = now_cn().date()
    try:
        d = curl_json(CM_ALL.format((today - timedelta(days=100)).isoformat(), today.isoformat()), post=True)
    except Exception:
        breaker.trip('cm', 1800)
        raise
    head = (d.get('data') or {}).get('head') or []
    table = {p: [] for p in head}
    for r in d.get('records') or []:
        for pair, v in zip(head, r.get('values') or []):
            x = fnum(v)
            if x:
                table[pair].append((r['date'][:10], x))
    for rows in table.values():
        rows.sort()
    if not table.get('USD/CNY'):
        raise ValueError('empty ccpr')
    write_json(os.path.join(CACHE_DIR, 'ccpr.json'), table)
    return table


def _cm_ttl(table):
    now = now_cn()
    last = (table.get('USD/CNY') or [('', 0)])[-1][0]
    if last >= now.date().isoformat():  # 今天的中间价已公布，下一次最早明早 9:15
        nxt = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), now.tzinfo) + timedelta(hours=9, minutes=16)
        return max(600, (nxt - now).total_seconds())
    return 900


def cm_table():
    try:
        return cache.get('ccpr', _cm_ttl, _cm_table)
    except Exception:  # noqa: BLE001
        old = read_json(os.path.join(CACHE_DIR, 'ccpr.json')) or {}
        cache.set('ccpr', old, 600)  # 失败也缓存一会儿，避免每次刷新都去碰壁
        return old


def fx_series(ccy):
    """人民币中间价序列 [(date, 每单位外币的人民币)]，QDII 估值用的就是它。取不到时退回汇率行情。"""
    pair = CM_PAIRS.get(ccy)
    table = _safe(cm_table) if pair else None
    rows = (table or {}).get(pair)
    if rows:
        return [(d, 1 / v) for d, v in rows] if pair.startswith('CNY/') else [tuple(r) for r in rows]
    return kline(fx_id(ccy))


def fx_rate_on(ccy, dstr, qmap=None):  # noqa: ARG001
    return close_on_or_before(fx_series(ccy), dstr)


def fx_ratio(ccy, base_date, target_date, qmap=None):
    """QDII 估值用估值日的中间价：比较目标交易日与净值日的中间价。"""
    if ccy == 'CNY' or not base_date or not target_date or target_date <= base_date:
        return 1.0
    a, b = fx_rate_on(ccy, base_date), fx_rate_on(ccy, target_date)
    return b / a if a and b else 1.0


# ---------- 搜索 ----------

def em_search(q, count=10):
    d = get_json(EM_SEARCH.format(urllib.parse.quote(q), count), timeout=6, retries=0)
    return [{'id': x.get('QuoteID'), 'code': x.get('Code'), 'name': x.get('Name'),
             'type': x.get('SecurityTypeName'), 'group': x.get('JYS') or ''}
            for x in ((d.get('QuotationCodeTable') or {}).get('Data') or []) if x.get('QuoteID')]


def search(q, limit=24):
    q = (q or '').strip()
    if not q:
        return catalog.all_items()
    res = catalog.match(q)
    low = q.lower()
    if low.startswith('yf:') or q.startswith('^') or q.endswith('=X') or q.endswith('=F'):
        sym = q[3:] if low.startswith('yf:') else q
        res.append({'id': 'yf:' + sym, 'code': sym, 'name': sym, 'type': '雅虎财经', 'group': '自定义'})
    hits = cache.get(('ems', low), lambda v: 86400 if v else 300, lambda: _safe(em_search, q, 20) or [])
    for x in hits:
        if not x['id'].startswith('150.'):  # 场外基金没有实时行情
            res.append(x)
    seen, out = set(), []
    for r in res:
        if r['id'] not in seen:
            seen.add(r['id'])
            out.append(r)
    return out[:limit]


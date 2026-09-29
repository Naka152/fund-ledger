"""基金数据（天天基金/东方财富）：基金列表与搜索、最新净值、历史净值、基本资料、
十大持仓、资产配置，以及指数基金跟踪标的的解析。"""
import json
import re
import time

import catalog
import market
from tradecal import nav_window
from util import cache, disk_cached, fnum, get_json, get_text, iomap

M = 'deviceid=Wap&plat=Wap&product=EFund&version=2.0.0'
API = 'https://fundmobapi.eastmoney.com'
URL_LIST = 'https://fund.eastmoney.com/js/fundcode_search.js'
URL_INFO = (API + '/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=200&plat=Android&appType=ttjj'
            '&product=EFund&Version=1&deviceid=fundledger&Fcodes={}')
URL_DETAIL = API + '/FundMNewApi/FundMNDetailInformation?FCODE={}&' + M
URL_BASE = API + '/FundMApi/FundBaseTypeInformation.ashx?FCODE={}&' + M
URL_POS = API + '/FundMNewApi/FundMNInverstPosition?FCODE={}&' + M
URL_ALLOC = API + '/FundMNewApi/FundMNAssetAllocationNew?FCODE={}&' + M
URL_NAVS = API + '/FundMNewApi/FundMNHisNetList?FCODE={}&pageIndex=1&pagesize={}&' + M

# 基金资料里的 INDEXCODE -> 行情标的。没有免费指数行情的用跟踪 ETF 代理。
INDEX_ALIAS = {
    'NDX100': '100.NDX100', 'NDX': '100.NDX100', 'IXIC': '100.NDX', 'SPX': '100.SPX', 'DJIA': '100.DJIA',
    'INDU': '100.DJIA', 'SBI': '107.XLK', 'S5INFT': '107.XLK', 'SPSIBI': '107.XBI', 'SPSIOP': '107.XOP',
    'DJSOEP': '107.IEO', 'NBI': '105.IBB', 'NDXTMC': '105.QTEC', 'NDXT': '105.QTEC', 'TPX': '107.EWJ',
    'FISAULMU': '107.KSA', 'SPG120035': '107.IXJ', 'SOX': '251.SOX', 'HSI': '100.HSI', 'HSCEI': '100.HSCEI',
    'HSTECH': '124.HSTECH', 'HSHCI': '124.HSHCI', 'HSIII': '124.HSIII', 'N225': '100.N225',
    'GDAXI': '100.GDAXI', 'DAX': '100.GDAXI', 'FCHI': '100.FCHI', 'CAC': '100.FCHI', 'BVSP': '100.BVSP',
    'IBOV': '100.BVSP', 'FTSE': '100.FTSE', 'UKX': '100.FTSE', 'SX5E': '100.SX5E', 'KS11': '100.KS11',
    'SENSEX': '100.SENSEX', 'VNINDEX': '100.VNINDEX', 'AS51': '100.AS51', 'AU9999': '118.AU9999',
    'RLG': '107.IWF', 'RU10GRTR': '107.IWF', 'RUT': '107.IWM', 'RU20INTR': '107.IWM',
}


def _try(fn):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return None


# ---------- 基金列表与搜索 ----------

def fund_list():
    def load():
        txt = get_text(URL_LIST, timeout=30)
        return json.loads(txt[txt.index('['): txt.rindex(']') + 1])
    return cache.get('fundlist', 6 * 3600, lambda: disk_cached('fundlist.json', 86400, load))


def search(q, limit=20):
    q = (q or '').strip()
    if not q:
        return []
    toks = q.lower().split()
    out = []
    for code, abbr, name, typ, py in fund_list():
        if '后端' in name:
            continue
        nl, al, pl = name.lower(), abbr.lower(), py.lower()
        if not all(t in code or t in nl or t in al or t in pl for t in toks):
            continue
        t0 = toks[0]
        if code == t0:
            s = 0
        elif code.startswith(t0):
            s = 1
        elif nl.startswith(t0) or al.startswith(t0):
            s = 2
        elif t0 in nl:
            s = 3
        else:
            s = 4
        out.append((s, len(name), code, name, typ))
    out.sort()
    return [{'code': c, 'name': n, 'type': t} for _, _, c, n, t in out[:limit]]


# ---------- 净值 ----------

def latest(codes):
    """最新公布净值 {code: {nav, date, pct}}，一次请求批量获取。"""
    ttl = 90 if nav_window() else 300
    out, need = {}, []
    for c in codes:
        v = cache.fresh(('latest', c))
        if v:
            out[c] = v
        else:
            need.append(c)
    for k in range(0, len(need), 50):
        chunk = need[k:k + 50]
        try:
            d = get_json(URL_INFO.format(','.join(chunk)), timeout=10)
            for x in d.get('Datas') or []:
                nav = fnum(x.get('NAV'))
                if not nav or not x.get('PDATE'):
                    continue
                v = {'code': x['FCODE'], 'name': x.get('SHORTNAME'), 'nav': nav, 'date': x['PDATE'][:10],
                     'pct': fnum(x.get('NAVCHGRT')), 'acc': fnum(x.get('ACCNAV'))}
                cache.set(('latest', x['FCODE']), v, ttl)
                out[x['FCODE']] = v
        except Exception:  # noqa: BLE001
            for c in chunk:
                v = cache.peek(('latest', c))
                if v:
                    out[c] = v
    return out


def navs(code, min_date=None, n=300):
    """历史净值 [[date, nav, acc_nav, pct]]，日期升序。

    min_date 是调用方已知已公布的最新净值日；缓存里没有它时重新拉取（最多两分钟一次）。
    """
    key = ('navs', code)
    v = cache.fresh(key)
    if v is not None and (not min_date or (v and v[-1][0] >= min_date)):
        return v
    stale = v if v is not None else cache.peek(key)
    last_try = cache.peek(('navs_try', code))
    if stale is not None and last_try and time.time() - last_try < 120:
        return stale
    cache.set(('navs_try', code), time.time(), 3600)
    try:
        d = get_json(URL_NAVS.format(code, n), timeout=12)
        rows = []
        for x in d.get('Datas') or []:
            nav = fnum(x.get('DWJZ'))
            if nav and x.get('FSRQ'):
                rows.append([x['FSRQ'][:10], nav, fnum(x.get('LJJZ')), fnum(x.get('JZZZL'))])
        rows.sort(key=lambda r: r[0])
        cache.set(key, rows, 6 * 3600)
        return rows
    except Exception:  # noqa: BLE001
        if stale is not None:
            return stale
        raise


# ---------- 基本资料 ----------

def _bench_ratio(bench):
    m = re.search(r'[*×xX]\s*(\d{2,3}(?:\.\d+)?)\s*%', bench or '')
    if m:
        v = float(m.group(1))
        if 50 <= v <= 100:
            return v / 100
    return None


def _kind(ftype, name):
    if ftype.startswith('货币'):
        return 'money'
    if ftype.startswith('债券') or '纯债' in ftype:
        return 'bond'
    if 'QDII' in ftype or 'QDII' in name or '海外' in ftype:
        return 'qdii'
    if ftype.startswith('指数型'):
        return 'index'
    if 'FOF' in ftype:
        return 'fof'
    return 'active'


def meta(code):
    return cache.get(('meta', code), 6 * 3600,
                     lambda: disk_cached(f'meta-{code}.json', 12 * 3600, lambda: _load_meta(code)))


def _load_meta(code):
    urls = [URL_DETAIL, URL_BASE, URL_POS, URL_ALLOC]
    det_raw, base_raw, pos_raw, alloc_raw = iomap(lambda u: get_json(u.format(code), timeout=8), urls)
    if det_raw is None:  # 资料接口偶尔超时，再试一次
        det_raw = get_json(URL_DETAIL.format(code), timeout=10)
    det = (det_raw or {}).get('Datas') or {}
    if not det.get('FCODE'):
        raise ValueError(f'找不到基金 {code}')
    base = (base_raw or {}).get('Datas') or {}
    pos_raw = pos_raw or {}
    alloc_raw = alloc_raw or {}
    pos = pos_raw.get('Datas') or {}
    stocks = []
    for s in pos.get('fundStocks') or []:
        mk, w = s.get('NEWTEXCH'), fnum(s.get('JZBL'))
        if mk and w and s.get('GPDM'):
            stocks.append({'id': f"{mk}.{s['GPDM']}", 'code': s['GPDM'], 'name': s.get('GPJC'),
                           'weight': w, 'industry': s.get('INDEXNAME')})
    alloc = (alloc_raw.get('Datas') or [None])[0] or {}
    for k in ('INDEXCODE', 'INDEXNAME', 'BENCH'):
        if (det.get(k) or '').strip() in ('', '--', '-'):
            det[k] = None
    ftype = det.get('FTYPE') or base.get('FTYPE') or ''
    name = det.get('SHORTNAME') or base.get('SHORTNAME') or code
    kind = _kind(ftype, name)
    is_qdii = kind == 'qdii'
    gp = fnum(alloc.get('GP'))
    m = {
        'code': code, 'name': name, 'fullName': det.get('FULLNAME'), 'type': ftype, 'kind': kind,
        'company': det.get('JJGS'), 'manager': det.get('JJJL'), 'established': det.get('ESTABDATE'),
        'isQDII': is_qdii, 'isIndex': ftype.startswith('指数型') or bool(det.get('INDEXCODE')),
        'indexCode': det.get('INDEXCODE'), 'indexName': det.get('INDEXNAME'),
        'bench': det.get('BENCH') or '', 'benchRatio': _bench_ratio(det.get('BENCH')),
        'etfCode': pos.get('ETFCODE'), 'etfName': pos.get('ETFSHORTNAME'),
        'stocks': stocks, 'stocksDate': pos_raw.get('Expansion'),
        'stockRatio': gp / 100 if gp else None, 'allocDate': alloc.get('FSRQ'),
        'buyStatus': base.get('SGZT'), 'sellStatus': base.get('SHZT'),
        'feeRate': fnum(base.get('RATE')), 'feeRateOrig': fnum(base.get('SOURCERATE')),
        'minDca': fnum(base.get('MINDT')),
        'confirmDays': int(fnum(base.get('SSBCFMDATA'), 2 if is_qdii else 1)),
    }
    m['indexId'], m['indexVia'], m['indexLabel'] = None, None, None
    if m['isIndex'] or m['etfCode']:
        m['indexId'], m['indexVia'], m['indexLabel'] = resolve_index(m)
    m['loadedAt'] = int(time.time())
    return m


def _clean_index_name(name):
    s = re.sub(r'[（(].*?[)）]', '', name or '')
    for w in ('收益率', '人民币', '指数'):
        s = s.replace(w, '')
    return s.strip()


def resolve_index(m):
    """把基金资料里的跟踪指数解析成可报价的标的，返回 (id, 来源, 显示名)。"""
    code = (m.get('indexCode') or '').strip()
    name = m.get('indexName') or ''
    nm = _clean_index_name(name)
    etf = m.get('etfCode')
    queries = [q for q in (code, nm, etf) if q]
    found = dict(zip(queries, iomap(market.em_search, queries)))
    cands = []
    if code.upper() in INDEX_ALIAS:
        cands.append((INDEX_ALIAS[code.upper()], 'alias'))
    for x in found.get(code) or []:
        if x['type'] == '指数' and (x['code'] or '').upper() == code.upper():
            cands.append((x['id'], 'code'))
    for x in found.get(nm) or []:
        xn = _clean_index_name(x['name'])
        if x['type'] == '指数' and xn and (xn in nm or nm in xn):
            cands.append((x['id'], 'name'))
            break
    for x in found.get(etf) or []:
        if x['code'] == etf and x['id'].split('.')[0] in ('0', '1'):
            cands.append((x['id'], 'etf'))
            break
    seen = set()
    for iid, via in cands:
        if iid in seen:
            continue
        seen.add(iid)
        q = market.quotes([iid]).get(iid)
        if q:
            label = catalog.name_of(iid) or (m.get('etfName') if via == 'etf' else None) or q.get('name') or name
            return iid, via, label
    return None, None, None

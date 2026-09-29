"""交易日历与市场状态。

A 股交易日 = 工作日且不是法定节假日（调休补班的周末也不开市）。
节假日数据来自 holiday-cn；取不到时退化为只排除周末。
"""
import threading
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from util import CN, disk_cached, get_json, now_cn

URLS = ['https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{y}.json',
        'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{y}.json']
NY = ZoneInfo('America/New_York')
HK = ZoneInfo('Asia/Hong_Kong')

_off = {}
_lock = threading.Lock()


def _fetch_year(y):
    last = None
    for u in URLS:
        try:
            d = get_json(u.format(y=y), timeout=10)
            return [x['date'] for x in d.get('days', []) if x.get('isOffDay')]
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def offdays(y):
    ent = _off.get(y)
    if ent and (ent[1] or time.time() - ent[0] < 3600):
        return ent[1]
    try:
        s = set(disk_cached(f'holiday-{y}.json', 7 * 86400, lambda: _fetch_year(y)))
    except Exception:  # noqa: BLE001
        s = set()
    with _lock:
        _off[y] = (time.time(), s)
    return s


def is_trading_day(d):
    return d.weekday() < 5 and d.isoformat() not in offdays(d.year)


def next_trading_day(d, n=1):
    while n > 0:
        d += timedelta(days=1)
        if is_trading_day(d):
            n -= 1
    return d


def prev_trading_day(d, n=1):
    while n > 0:
        d -= timedelta(days=1)
        if is_trading_day(d):
            n -= 1
    return d


def first_trading_on_or_after(d):
    while not is_trading_day(d):
        d += timedelta(days=1)
    return d


def trading_days(a, b):
    out, d = [], a
    while d <= b:
        if is_trading_day(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def _mins(dt):
    return dt.hour * 60 + dt.minute


def market_status(now=None, quote_dates=None):
    """返回 A 股 / 港股 / 美股 的交易状态。quote_dates 用来识别港美股假期。"""
    now = now or now_cn()
    qd = quote_dates or {}
    out = []

    d, t = now.date(), _mins(now)
    if not is_trading_day(d):
        st = ('closed', '休市')
    elif t < 9 * 60 + 15:
        st = ('pre', '未开盘')
    elif t < 9 * 60 + 30:
        st = ('pre', '集合竞价')
    elif t < 11 * 60 + 30 or 13 * 60 <= t < 15 * 60:
        st = ('open', '交易中')
    elif t < 13 * 60:
        st = ('break', '午间休市')
    else:
        st = ('closed', '已收盘')
    out.append({'key': 'cn', 'name': 'A股', 'state': st[0], 'label': st[1]})

    h = now.astimezone(HK)
    t = _mins(h)
    if h.weekday() >= 5:
        st = ('closed', '休市')
    elif t < 9 * 60 + 30:
        st = ('pre', '未开盘')
    elif t < 12 * 60 or 13 * 60 <= t < 16 * 60 + 10:
        st = ('open', '交易中')
    elif t < 13 * 60:
        st = ('break', '午间休市')
    else:
        st = ('closed', '已收盘')
    if st[0] in ('open', 'break') and t > 9 * 60 + 45 and qd.get('hk') and qd['hk'] < h.date():
        st = ('closed', '休市')
    out.append({'key': 'hk', 'name': '港股', 'state': st[0], 'label': st[1]})

    u = now.astimezone(NY)
    t = _mins(u)
    if u.weekday() >= 5:
        st = ('closed', '休市')
    elif t < 4 * 60:
        st = ('closed', '已收盘')
    elif t < 9 * 60 + 30:
        st = ('pre', '盘前')
    elif t < 16 * 60:
        st = ('open', '交易中')
    elif t < 20 * 60:
        st = ('closed', '盘后')
    else:
        st = ('closed', '已收盘')
    if st[0] == 'open' and t > 9 * 60 + 45 and qd.get('us') and qd['us'] < u.date():
        st = ('closed', '休市')
    out.append({'key': 'us', 'name': '美股', 'state': st[0], 'label': st[1]})
    return out


def any_open(status):
    return any(m['state'] == 'open' for m in status)


def nav_window(now=None):
    """A 股交易日 15:00 以后是净值集中公布的时段，需要更频繁地检查净值。"""
    now = now or now_cn()
    return now.hour >= 15 or now.hour < 1

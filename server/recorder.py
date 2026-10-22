"""盘中估值记录：任一市场交易时，每分钟为每个有持仓的账户记一次组合估值，用来画当天的估值走势。

“估值日”从北京时间 06:00 到次日 06:00，覆盖 A 股、港股白天和美股夜盘。
数据存在 data/users/<uid>/intraday/<日期>.json。
"""
import os
import threading
import time
import traceback
from datetime import timedelta

import auth
import market
import portfolio
from tradecal import market_status
from util import now_cn, read_json, write_json

KEEP_DAYS = 10
_lock = threading.Lock()
_days = {}  # uid -> {'date', 'points', 'dirty'}
_extra_uids = []


def session_day(now):
    return (now - timedelta(hours=6)).date().isoformat()


def _dir(uid):
    path = os.path.join(auth.user_dir(uid), 'intraday')
    os.makedirs(path, exist_ok=True)
    return path


def _flush(uid, force=False):
    day = _days.get(uid)
    if day and day['dirty'] and (force or time.time() - day['dirty'] > 300):
        write_json(os.path.join(_dir(uid), f"{day['date']}.json"), {'date': day['date'], 'points': day['points']})
        day['dirty'] = 0


def record(uid, res, now):
    d = session_day(now)
    with _lock:
        day = _days.get(uid)
        if not day or day['date'] != d:
            _flush(uid, force=True)
            old = read_json(os.path.join(_dir(uid), f'{d}.json'), {}) or {}
            day = _days[uid] = {'date': d, 'points': old.get('points') or [], 'dirty': 0}
        t = res['totals']
        codes = {}
        for r in res['holdings'] + res.get('favs', []):  # 每只基金的估算涨跌（持仓与自选共用，按代码）
            e = r.get('est') or {}
            if e.get('live') and e.get('estPct') is not None:
                codes[r['code']] = round(e['estPct'], 3)
        day['points'].append({
            't': int(now.timestamp()), 'v': round(t['estValue'], 2), 'b': round(t['value'], 2),
            'g': {g['id']: [round(g['totals']['estValue'], 2), round(g['totals']['value'], 2)]
                  for g in res.get('groups', []) if g['count']},
            'c': codes,
            # 每只持仓的 [估算市值, 估算持有收益, 较最新净值的估算盈亏]：全屏走势里画分基金折线用
            # （用持有收益的变化而不是市值的变化，定投加仓不会造成跳变）
            'hp': {r['id']: [round(r['estValue'], 2), round(r['estPnl'], 2), round(r.get('estDayPnl') or 0, 2)]
                   for r in res['holdings'] if r.get('estValue') is not None and r.get('estPnl') is not None},
        })
        if not day['dirty']:
            day['dirty'] = time.time()
        _flush(uid)


def series(uid, d=None, days=1):
    """某个估值日的分钟记录；days>1 时把最近几个有记录的估值日拼起来。"""
    today = session_day(now_cn())
    if days > 1 and not d:
        names = {f[:-5] for f in os.listdir(_dir(uid)) if f.endswith('.json')}
        with _lock:
            if uid in _days:
                names.add(_days[uid]['date'])
        keep = sorted(x for x in names if x <= today)[-days:]
        pts = []
        for x in keep:
            pts += series(uid, x)['points']
        pts.sort(key=lambda p: p['t'])
        return {'date': today, 'days': keep, 'points': pts}
    d = d or today
    with _lock:
        day = _days.get(uid)
        if day and day['date'] == d:
            return {'date': d, 'points': list(day['points'])}
    return read_json(os.path.join(_dir(uid), f'{d}.json'), {'date': d, 'points': []})


def _uids():
    return [u['id'] for u in auth.list_users()] + _extra_uids


def _cleanup():
    for uid in _uids():
        try:
            path = _dir(uid)
            for f in sorted(x for x in os.listdir(path) if x.endswith('.json'))[:-KEEP_DAYS]:
                os.remove(os.path.join(path, f))
        except OSError:
            pass


def _loop():
    while True:
        now = now_cn()
        try:
            if any(m['state'] == 'open' for m in market_status(now)):
                for uid in _uids():
                    st = portfolio.load(uid)
                    if st['holdings'] or st['favs']:
                        res = portfolio.compute(uid)
                        if any(m['state'] == 'open' for m in res['markets']):
                            record(uid, res, now)
            elif now.minute % 10 == 0:
                with _lock:
                    for uid in list(_days):
                        _flush(uid, force=True)
                market.flush_closes(force=True)
            if now.hour == 6 and now.minute == 30:
                _cleanup()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(max(5, 60 - now_cn().second))


def start(extra_uids=()):
    _extra_uids.extend(extra_uids)
    threading.Thread(target=_loop, name='recorder', daemon=True).start()

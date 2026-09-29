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
        day['points'].append({
            't': int(now.timestamp()), 'v': round(t['estValue'], 2), 'b': round(t['value'], 2),
            'h': {r['id']: round(r['est']['estPct'], 3) for r in res['holdings']
                  if r.get('est') and r['est'].get('live') and r['est'].get('estPct') is not None},
        })
        if not day['dirty']:
            day['dirty'] = time.time()
        _flush(uid)


def series(uid, d=None):
    d = d or session_day(now_cn())
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
                    if portfolio.load(uid)['holdings']:
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

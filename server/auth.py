"""账户与登录：用户名 + 密码（scrypt 加盐哈希），服务端会话，登录限速。

  data/users.json     用户列表与站点设置（仅服务账户可读）
  data/sessions.json  会话：只存令牌的 SHA-256，泄露了也无法直接冒用
  data/users/<uid>/   每个用户自己的持仓、盘中记录
"""
import base64
import hashlib
import hmac
import os
import re
import secrets
import shutil
import threading
import time
import unicodedata

from util import DATA, now_cn, read_json, write_json

USERS = os.path.join(DATA, 'users.json')
SESSIONS = os.path.join(DATA, 'sessions.json')
USER_DIR = os.path.join(DATA, 'users')
SESSION_DAYS = 30
SHORT_SESSION_HOURS = 12
USERNAME_RE = re.compile(r'^[A-Za-z0-9_.\-一-鿿]{2,32}$')
MIN_PASSWORD = 6
_lock = threading.RLock()
_sessions = None
_sessions_saved = [0.0]
_sessions_mtime = [0.0]
_fails = {}


def _b64(b):
    return base64.b64encode(b).decode()


def _nfc(s):
    return unicodedata.normalize('NFC', s or '')


def _ukey(username):
    return _nfc(username).strip().lower()


# ---------- 密码 ----------

def hash_password(pw):
    salt = secrets.token_bytes(16)
    n, r, p = 2 ** 14, 8, 1
    h = hashlib.scrypt(_nfc(pw).encode('utf-8'), salt=salt, n=n, r=r, p=p, dklen=32, maxmem=64 << 20)
    return f'scrypt${n}${r}${p}${_b64(salt)}${_b64(h)}'


def verify_password(pw, stored):
    try:
        _, n, r, p, salt, h = stored.split('$')
        calc = hashlib.scrypt(_nfc(pw).encode('utf-8'), salt=base64.b64decode(salt), n=int(n), r=int(r),
                              p=int(p), dklen=32, maxmem=64 << 20)
        return hmac.compare_digest(calc, base64.b64decode(h))
    except (ValueError, TypeError):
        return False


_DUMMY = hash_password(secrets.token_hex(8))  # 用户名不存在时也算一次哈希，响应时间一致


def check_password_rules(pw):
    if len(_nfc(pw)) < MIN_PASSWORD:
        raise ValueError(f'密码至少 {MIN_PASSWORD} 位')
    if len(pw) > 128:
        raise ValueError('密码太长')


# ---------- 用户 ----------

def _load():
    d = read_json(USERS) or {}
    d.setdefault('users', [])
    d.setdefault('settings', {'openSignup': False})
    return d


def _save(d):
    write_json(USERS, d)
    os.chmod(USERS, 0o600)


def public(u):
    return {'id': u['id'], 'username': u['username'], 'admin': bool(u.get('admin')),
            'created': u.get('created'), 'lastLogin': u.get('lastLogin')}


def list_users():
    with _lock:
        return [public(u) for u in _load()['users']]


def settings():
    with _lock:
        return dict(_load()['settings'])


def set_settings(**kw):
    with _lock:
        d = _load()
        d['settings'].update(kw)
        _save(d)
        return dict(d['settings'])


def get_user(uid):
    with _lock:
        return next((u for u in _load()['users'] if u['id'] == uid), None)


def find_user(username):
    k = _ukey(username)
    with _lock:
        return next((u for u in _load()['users'] if _ukey(u['username']) == k), None)


def user_dir(uid):
    if not re.fullmatch(r'u[0-9a-f]{10}|local', uid or ''):
        raise ValueError('bad uid')
    path = os.path.join(USER_DIR, uid)
    os.makedirs(path, exist_ok=True)
    return path


def create_user(username, password, admin=False):
    username = _nfc(username).strip()
    if not USERNAME_RE.fullmatch(username):
        raise ValueError('用户名为 2–32 位字母、数字、汉字或 _ . -')
    check_password_rules(password)
    hashed = hash_password(password)
    with _lock:
        d = _load()
        if any(_ukey(u['username']) == _ukey(username) for u in d['users']):
            raise ValueError('这个用户名已经被使用了')
        u = {'id': 'u' + secrets.token_hex(5), 'username': username, 'hash': hashed, 'admin': bool(admin),
             'created': now_cn().isoformat(timespec='seconds'), 'lastLogin': None}
        d['users'].append(u)
        _save(d)
    user_dir(u['id'])
    return public(u)


def set_password(uid, password):
    check_password_rules(password)
    hashed = hash_password(password)
    with _lock:
        d = _load()
        for u in d['users']:
            if u['id'] == uid:
                u['hash'] = hashed
                _save(d)
                return True
    raise KeyError('用户不存在')


def set_admin(uid, admin):
    with _lock:
        d = _load()
        for u in d['users']:
            if u['id'] == uid:
                if not admin and sum(1 for x in d['users'] if x.get('admin')) <= 1 and u.get('admin'):
                    raise ValueError('至少要保留一个管理员')
                u['admin'] = bool(admin)
                _save(d)
                return public(u)
    raise KeyError('用户不存在')


def delete_user(uid):
    """删除账户。数据目录移到 data/deleted/ 保留，不直接抹掉。"""
    with _lock:
        d = _load()
        u = next((x for x in d['users'] if x['id'] == uid), None)
        if not u:
            raise KeyError('用户不存在')
        if u.get('admin') and sum(1 for x in d['users'] if x.get('admin')) <= 1:
            raise ValueError('不能删除唯一的管理员')
        d['users'] = [x for x in d['users'] if x['id'] != uid]
        _save(d)
    drop_user_sessions(uid)
    src = os.path.join(USER_DIR, uid)
    if os.path.isdir(src):
        dst = os.path.join(DATA, 'deleted', f'{uid}-{int(time.time())}')
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
    return True


def claim_legacy(uid):
    """把旧版单用户数据（data/state.json、data/intraday/）归到某个账户下。"""
    dst = user_dir(uid)
    moved = []
    old_state = os.path.join(DATA, 'state.json')
    if os.path.exists(old_state):
        target = os.path.join(dst, 'state.json')
        if os.path.exists(target):
            cur, old = read_json(target) or {}, read_json(old_state) or {}
            cur.setdefault('holdings', []).extend(old.get('holdings') or [])
            write_json(target, cur)
            os.remove(old_state)
        else:
            shutil.move(old_state, target)
        moved.append('state.json')
    old_intraday = os.path.join(DATA, 'intraday')
    if os.path.isdir(old_intraday):
        tdir = os.path.join(dst, 'intraday')
        os.makedirs(tdir, exist_ok=True)
        for f in os.listdir(old_intraday):
            shutil.move(os.path.join(old_intraday, f), os.path.join(tdir, f))
        os.rmdir(old_intraday)
        moved.append('intraday')
    return moved


# ---------- 登录限速 ----------

def _limited(key, limit, window):
    now = time.time()
    with _lock:
        lst = [t for t in _fails.get(key, []) if now - t < window]
        _fails[key] = lst
        return len(lst) >= limit


def _fail(*keys):
    with _lock:
        for k in keys:
            _fails.setdefault(k, []).append(time.time())


def authenticate(username, password, ip):
    """校验用户名密码，成功返回用户。失败太多次会被暂时拒绝。"""
    k = _ukey(username)
    if _limited('ip:' + ip, 20, 600) or _limited('u:' + k, 8, 900):
        raise PermissionError('尝试次数太多，请过一会儿再试')
    u = find_user(username)
    ok = verify_password(password, u['hash'] if u else _DUMMY)
    if not (u and ok):
        _fail('ip:' + ip, 'u:' + k)
        return None
    with _lock:
        d = _load()
        for x in d['users']:
            if x['id'] == u['id']:
                x['lastLogin'] = now_cn().isoformat(timespec='seconds')
        _save(d)
    return u


# ---------- 会话 ----------

def _tok(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _mtime():
    try:
        return os.path.getmtime(SESSIONS)
    except OSError:
        return 0.0


def _sess():
    """会话表。文件被命令行工具改过（例如重设密码踢下线）时自动重新读取。"""
    global _sessions
    mt = _mtime()
    if _sessions is None or mt != _sessions_mtime[0]:
        raw = read_json(SESSIONS) or {}
        now = time.time()
        _sessions = {k: v for k, v in raw.items() if v.get('exp', 0) > now}
        _sessions_mtime[0] = mt
    return _sessions


def _save_sessions(force=False):
    if force or time.time() - _sessions_saved[0] > 60:
        _sessions_saved[0] = time.time()
        write_json(SESSIONS, _sess())
        os.chmod(SESSIONS, 0o600)
        _sessions_mtime[0] = _mtime()


def create_session(uid, remember=True, ua=''):
    token = secrets.token_urlsafe(32)
    ttl = SESSION_DAYS * 86400 if remember else SHORT_SESSION_HOURS * 3600
    with _lock:
        s = _sess()
        now = time.time()
        for k in [k for k, v in s.items() if v.get('exp', 0) <= now]:
            s.pop(k, None)
        s[_tok(token)] = {'uid': uid, 'exp': now + ttl, 'ttl': ttl, 'created': int(now), 'ua': (ua or '')[:160]}
        _save_sessions(force=True)
    return token, ttl


def session_user(token):
    if not token:
        return None
    with _lock:
        s = _sess()
        ent = s.get(_tok(token))
        now = time.time()
        if not ent or ent.get('exp', 0) <= now:
            return None
        if ent['exp'] - now < ent.get('ttl', 0) / 2:  # 用着的会话自动续期
            ent['exp'] = now + ent['ttl']
            _save_sessions()
    return get_user(ent['uid'])


def drop_session(token):
    if token:
        with _lock:
            _sess().pop(_tok(token), None)
            _save_sessions(force=True)


def drop_user_sessions(uid, keep_token=None):
    keep = _tok(keep_token) if keep_token else None
    with _lock:
        s = _sess()
        for k in [k for k, v in s.items() if v.get('uid') == uid and k != keep]:
            s.pop(k, None)
        _save_sessions(force=True)

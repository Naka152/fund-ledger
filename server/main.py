"""净值簿 HTTP 服务：静态页面 + JSON API。多用户，用户名 + 密码登录。

  python3 server/main.py                              启动（HOST / PORT / FL_DATA；FL_AUTH=off 仅供本机调试）
  python3 server/main.py --add-user 名字 [--admin]    新建账户，密码从标准输入读取
  python3 server/main.py --set-password 名字          重设密码并让该账户所有设备重新登录
  python3 server/main.py --list-users                 列出账户
  python3 server/main.py --claim-legacy 名字          把旧版单用户数据归到这个账户
"""
import json
import mimetypes
import os
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import auth  # noqa: E402
import estimate  # noqa: E402
import fundsrc  # noqa: E402
import market  # noqa: E402
import portfolio  # noqa: E402
import recorder  # noqa: E402
from util import DATA, POOL, ROOT, now_cn, pmap  # noqa: E402

WEB = os.path.join(ROOT, 'web')
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8766'))
AUTH = os.environ.get('FL_AUTH', 'on') != 'off'
COOKIE = 'fl_sid'
LOCAL_USER = {'id': 'local', 'username': '本机', 'admin': True}
MAX_BODY = 1 << 20


# ---------- 路由 ----------

ROUTES = []


def route(method, pattern, public=False, admin=False):
    def deco(fn):
        ROUTES.append((method, re.compile('^' + pattern + '$'), fn, public, admin))
        return fn
    return deco


class HttpError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


@route('GET', '/api/health', public=True)
def api_health(req, **_):
    return {'ok': True, 'time': now_cn().isoformat(timespec='seconds')}


@route('GET', '/api/session', public=True)
def api_session(req, **_):
    u = req.user()
    return {'auth': AUTH, 'user': auth.public(u) if u and AUTH else u,
            'openSignup': bool(auth.settings().get('openSignup')) if AUTH else False}


@route('POST', '/api/login', public=True)
def api_login(req, **_):
    b = req.json()
    try:
        u = auth.authenticate(str(b.get('username') or ''), str(b.get('password') or ''), req.client_ip())
    except PermissionError as e:
        raise HttpError(429, str(e)) from None
    if not u:
        raise HttpError(401, '用户名或密码不对')
    req.start_session(u, b.get('remember', True) is not False)
    return {'ok': True, 'user': auth.public(u)}


@route('POST', '/api/signup', public=True)
def api_signup(req, **_):
    if not AUTH or not auth.settings().get('openSignup'):
        raise HttpError(403, '暂未开放注册，请联系管理员开通账户')
    b = req.json()
    u = auth.create_user(str(b.get('username') or ''), str(b.get('password') or ''))
    req.start_session(auth.get_user(u['id']), True)
    return {'ok': True, 'user': u}


@route('POST', '/api/logout', public=True)
def api_logout(req, **_):
    auth.drop_session(req.token())
    req.set_cookie = f'{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
    return {'ok': True}


@route('POST', '/api/account/password')
def api_password(req, **_):
    b = req.json()
    u = req.user()
    if not AUTH:
        raise HttpError(400, '本机调试模式没有密码')
    try:
        ok = auth.authenticate(u['username'], str(b.get('old') or ''), req.client_ip())
    except PermissionError as e:
        raise HttpError(429, str(e)) from None
    if not ok:
        raise HttpError(400, '原密码不对')
    auth.set_password(u['id'], str(b.get('new') or ''))
    auth.drop_user_sessions(u['id'], keep_token=req.token())
    return {'ok': True}


@route('GET', '/api/admin/users', admin=True)
def api_users(req, **_):
    return {'users': auth.list_users(), 'settings': auth.settings()}


@route('POST', '/api/admin/users', admin=True)
def api_user_add(req, **_):
    b = req.json()
    return auth.create_user(str(b.get('username') or ''), str(b.get('password') or ''), bool(b.get('admin')))


@route('PATCH', r'/api/admin/users/(?P<uid>u[0-9a-f]{10})', admin=True)
def api_user_update(req, uid):
    b = req.json()
    if 'password' in b:
        auth.set_password(uid, str(b['password'] or ''))
        auth.drop_user_sessions(uid)
    if 'admin' in b:
        if uid == req.uid and not b['admin']:
            raise HttpError(400, '不能取消自己的管理员权限')
        auth.set_admin(uid, bool(b['admin']))
    return {'ok': True}


@route('DELETE', r'/api/admin/users/(?P<uid>u[0-9a-f]{10})', admin=True)
def api_user_delete(req, uid):
    if uid == req.uid:
        raise HttpError(400, '不能删除自己')
    return {'ok': auth.delete_user(uid)}


@route('PUT', '/api/admin/settings', admin=True)
def api_site_settings(req, **_):
    b = req.json()
    return auth.set_settings(openSignup=bool(b.get('openSignup')))


@route('GET', '/api/portfolio')
def api_portfolio(req, **_):
    return portfolio.compute(req.uid)


@route('GET', '/api/intraday')
def api_intraday(req, **_):
    return recorder.series(req.uid, req.q('date'))


@route('GET', '/api/state')
def api_state(req, **_):
    return portfolio.load(req.uid)


@route('POST', '/api/holdings')
def api_create(req, **_):
    return portfolio.create_holding(req.uid, req.json())


@route('PATCH', r'/api/holdings/(?P<hid>h[0-9a-f]+)')
def api_update(req, hid):
    return portfolio.update_holding(req.uid, hid, req.json())


@route('DELETE', r'/api/holdings/(?P<hid>h[0-9a-f]+)')
def api_delete(req, hid):
    return {'ok': portfolio.delete_holding(req.uid, hid)}


@route('POST', '/api/holdings/order')
def api_order(req, **_):
    return {'ok': portfolio.reorder(req.uid, req.json().get('ids') or [])}


def _find(uid, hid):
    for h in portfolio.load(uid)['holdings']:
        if h['id'] == hid:
            return h
    raise HttpError(404, '持仓不存在')


@route('GET', r'/api/holdings/(?P<hid>h[0-9a-f]+)/ledger')
def api_ledger(req, hid):
    h = _find(req.uid, hid)
    lat = fundsrc.latest([h['code']]).get(h['code'])
    navs = fundsrc.navs(h['code'], (lat or {}).get('date'))
    if lat and (not navs or navs[-1][0] < lat['date']):
        navs = navs + [[lat['date'], lat['nav'], lat.get('acc'), lat.get('pct')]]
    return {'ledger': portfolio.dca_ledger(h, navs)[::-1], 'next': portfolio.dca_next(h)}


def _with_cfg(h, req):
    """回测时可以用查询参数临时替换估算方式，方便比较。"""
    mode = req.q('mode')
    if not mode:
        return h
    link = req.q('link')
    beta = req.q('beta')
    est = {'mode': mode, 'link': {'id': link, 'name': req.q('linkName') or link} if link else None,
           'beta': float(beta) if beta else None, 'fx': req.q('fx') != '0'}
    return dict(h, est=est)


@route('GET', r'/api/funds/(?P<code>\d{6})/backtest')
def api_backtest(req, code):
    hid = req.q('hid')
    h = _find(req.uid, hid) if hid else {'id': '_', 'code': code, 'shares': 0, 'cost': 0, 'est': {'mode': 'auto'}}
    h = _with_cfg(h, req)
    meta = fundsrc.meta(code)
    navs = fundsrc.navs(code)
    pmap(lambda i: market.kline(i), estimate.backtest_ids(h, meta))
    return estimate.backtest(h, meta, navs, n=int(req.q('n') or 60)) or {'n': 0}


@route('GET', '/api/funds/search')
def api_fund_search(req, **_):
    return fundsrc.search(req.q('q'), limit=20)


@route('GET', r'/api/funds/(?P<code>\d{6})')
def api_fund(req, code):
    try:
        return portfolio.fund_detail(code)
    except ValueError as e:
        raise HttpError(404, str(e)) from None


@route('GET', '/api/instruments/search')
def api_inst_search(req, **_):
    return market.search(req.q('q'))


@route('GET', '/api/quotes')
def api_quotes(req, **_):
    ids = [i for i in (req.q('ids') or '').split(',') if i][:40]
    return market.quotes(ids)


@route('PUT', '/api/watch')
def api_watch(req, **_):
    return portfolio.set_watch(req.uid, req.json().get('ids') or [])


@route('PUT', '/api/prefs')
def api_prefs(req, **_):
    body = req.json()

    def upd(st):
        p = st.setdefault('prefs', {})
        for k in ('upColor', 'theme', 'sort'):
            if k in body:
                p[k] = str(body[k])[:20]
        return p
    return portfolio.mutate(req.uid, upd)


# ---------- HTTP ----------

STATIC_LONG = ('/vendor/', '/fonts/')
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")


class Handler(BaseHTTPRequestHandler):
    server_version = 'FundLedger'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # 只记录错误
        pass

    def client_ip(self):
        return (self.headers.get('X-Forwarded-For') or self.client_address[0]).split(',')[0].strip()

    def token(self):
        m = re.search(r'(?:^|;)\s*' + COOKIE + r'=([A-Za-z0-9_\-]{20,64})', self.headers.get('Cookie') or '')
        return m.group(1) if m else None

    def user(self):
        if not AUTH:
            return LOCAL_USER
        if not hasattr(self, '_user'):
            self._user = auth.session_user(self.token())
        return self._user

    @property
    def uid(self):
        return self.user()['id']

    def start_session(self, u, remember):
        token, ttl = auth.create_session(u['id'], remember, self.headers.get('User-Agent'))
        cookie = f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax'
        if remember:
            cookie += f'; Max-Age={ttl}'
        if self.headers.get('X-Forwarded-Proto') == 'https':
            cookie += '; Secure'
        self.set_cookie = cookie

    def q(self, name):
        v = self._qs.get(name)
        return v[0] if v else None

    def _read_body(self):
        """先把请求体读完：提前返回错误时如果不读，残留字节会串到同一连接的下一个请求里。"""
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        if n > MAX_BODY:
            self.close_connection = True
            return None
        return self.rfile.read(n) if n > 0 else b''

    def json(self):
        if self._body is None:
            raise HttpError(413, '请求太大')
        raw = self._body or b'{}'
        try:
            v = json.loads(raw or b'{}')
        except ValueError:
            raise HttpError(400, '请求格式不对') from None
        if not isinstance(v, dict):
            raise HttpError(400, '请求格式不对')
        return v

    def do_GET(self):
        self._dispatch('GET')

    def do_HEAD(self):
        self._dispatch('GET', head=True)

    def do_POST(self):
        self._dispatch('POST')

    def do_PUT(self):
        self._dispatch('PUT')

    def do_PATCH(self):
        self._dispatch('PATCH')

    def do_DELETE(self):
        self._dispatch('DELETE')

    def _dispatch(self, method, head=False):
        raw = self.path
        try:  # 容忍请求行里未编码的 UTF-8
            raw = raw.encode('latin-1').decode('utf-8')
        except UnicodeError:
            pass
        parts = urlsplit(raw)
        path = unquote(parts.path)
        self._qs = parse_qs(parts.query)
        self._body = self._read_body()
        self.set_cookie = None
        if hasattr(self, '_user'):  # 同一连接上的下一个请求要重新识别用户
            del self._user
        if path.startswith('/api/'):
            return self._api(method, path)
        if method != 'GET':
            return self._send(405, b'', 'text/plain')
        return self._static(path, head)

    def _api(self, method, path):
        for m, rx, fn, public, admin in ROUTES:
            mt = rx.match(path)
            if mt and m == method:
                break
        else:
            return self._json(404, {'error': '没有这个接口'})
        if method != 'GET' and self.headers.get('X-FL') != '1':  # 防跨站请求：自家页面的请求都带这个头
            return self._json(403, {'error': '请求来源不对'})
        if not public and not self.user():
            return self._json(401, {'error': '需要登录'})
        if admin and not self.user().get('admin'):
            return self._json(403, {'error': '需要管理员权限'})
        try:
            out = fn(self, **mt.groupdict())
            return self._json(200, out)
        except HttpError as e:
            return self._json(e.status, {'error': str(e)})
        except ValueError as e:
            return self._json(400, {'error': str(e)})
        except KeyError as e:
            return self._json(404, {'error': str(e.args[0]) if e.args else '不存在'})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._json(502, {'error': f'数据源暂时不可用：{type(e).__name__}'})

    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False, separators=(',', ':'), allow_nan=False,
                          default=str).encode()
        self._send(status, body, 'application/json; charset=utf-8', {'Cache-Control': 'no-store'})

    def _static(self, path, head):
        if path == '/' or not os.path.splitext(path)[1]:
            path = '/index.html'
        full = os.path.normpath(os.path.join(WEB, path.lstrip('/')))
        if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
            return self._send(404, b'not found', 'text/plain')
        st = os.stat(full)
        etag = f'"{int(st.st_mtime)}-{st.st_size}"'
        headers = {'ETag': etag}
        if path.startswith(STATIC_LONG):
            headers['Cache-Control'] = 'public, max-age=2592000, immutable'
        else:
            headers['Cache-Control'] = 'no-cache'
        if self.headers.get('If-None-Match') == etag:
            return self._send(304, b'', None, headers)
        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        with open(full, 'rb') as f:
            body = f.read()
        self._send(200, b'' if head else body, ctype, headers, length=len(body))

    def _send(self, status, body, ctype, headers=None, length=None):
        try:
            self.send_response(status)
            if ctype:
                self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body) if length is None else length))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Security-Policy', CSP)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            if self.set_cookie:
                self.send_header('Set-Cookie', self.set_cookie)
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('font/woff2', '.woff2')
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('application/manifest+json', '.webmanifest')


def _read_password():
    if sys.stdin.isatty():
        import getpass
        a = getpass.getpass('密码：')
        if a != getpass.getpass('再输一次：'):
            sys.exit('两次输入的密码不一致')
        return a
    return sys.stdin.buffer.read().decode('utf-8').rstrip('\r\n')


def _cli(args):
    def after(flag):
        i = args.index(flag)
        if i + 1 >= len(args):
            sys.exit(f'{flag} 后面要跟用户名')
        return args[i + 1]

    def need(name):
        u = auth.find_user(name)
        if not u:
            sys.exit(f'没有这个用户：{name}')
        return u

    if '--list-users' in args:
        for u in auth.list_users():
            print(u['id'], u['username'], '管理员' if u['admin'] else '', u['created'], u['lastLogin'] or '')
    elif '--add-user' in args:
        u = auth.create_user(after('--add-user'), _read_password(), admin='--admin' in args)
        print('已创建', u['username'], u['id'], '管理员' if u['admin'] else '')
        if '--claim-legacy' in args:
            print('已归入旧数据：', auth.claim_legacy(u['id']) or '无')
    elif '--set-password' in args:
        u = need(after('--set-password'))
        auth.set_password(u['id'], _read_password())
        auth.drop_user_sessions(u['id'])
        print('已重设密码', u['username'])
    elif '--claim-legacy' in args:
        u = need(after('--claim-legacy'))
        print('已归入旧数据：', auth.claim_legacy(u['id']) or '无')
    elif '--check-password' in args:
        u = need(after('--check-password'))
        print('ok' if auth.verify_password(_read_password(), u['hash']) else 'mismatch')
    else:
        return False
    return True


def main():
    try:
        if _cli(sys.argv[1:]):
            return
    except ValueError as e:
        sys.exit(str(e))
    POOL.submit(lambda: fundsrc.fund_list())  # 预热基金列表
    recorder.start(() if AUTH else ('local',))
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f'净值簿 listening on http://{HOST}:{PORT}  auth={"on" if AUTH else "off"}  '
          f'users={len(auth.list_users())}  data={DATA}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()

"""通用工具：上游 HTTP、带并发去重的 TTL 缓存、线程池、时区与 JSON 持久化。"""
import gzip
import json
import os
import subprocess
import threading
import time
import urllib.request
import zlib
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

CN = ZoneInfo('Asia/Shanghai')
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0 Safari/537.36')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('FL_DATA') or os.path.join(ROOT, 'data')
CACHE_DIR = os.path.join(DATA, 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

# 线程池分工（避免嵌套等待造成死锁）：
#   POOL 由请求线程/后台线程提交较大的任务；IO 只跑单个上游请求，池内任务不再提交任务；
#   BG 跑低优先级的后台计算（β 校准），不和页面请求抢线程。
POOL = ThreadPoolExecutor(max_workers=16, thread_name_prefix='up')
IO = ThreadPoolExecutor(max_workers=24, thread_name_prefix='io')
BG = ThreadPoolExecutor(max_workers=2, thread_name_prefix='bg')


def now_cn():
    return datetime.now(CN)


def today_cn():
    return now_cn().date()


def d2s(d):
    return d.isoformat() if d else None


def s2d(s):
    return date.fromisoformat(s[:10]) if s else None


def http_get(url, headers=None, timeout=10, retries=1, data=None):
    h = {'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate', 'Accept': '*/*'}
    if headers:
        h.update(headers)
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=h, data=data)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
                enc = (r.headers.get('Content-Encoding') or '').lower()
                if enc == 'gzip':
                    data = gzip.decompress(data)
                elif enc == 'deflate':
                    data = zlib.decompress(data)
                return data
        except Exception as e:  # noqa: BLE001 - 上游错误统一重试
            last = e
            if i < retries:
                time.sleep(0.4 * (i + 1))
    raise last


def get_text(url, encoding='utf-8', **kw):
    return http_get(url, **kw).decode(encoding, 'replace')


def get_json(url, **kw):
    return json.loads(get_text(url, **kw))


def curl_json(url, post=False, timeout=8):
    """用 curl 取 JSON：少数网站会拦截 Python 的 HTTP 客户端，但放行 curl。"""
    cmd = ['curl', '-s', '-f', '-m', str(timeout), '-A', UA, '-H', 'Accept: application/json, */*']
    if post:
        cmd += ['-X', 'POST']
    r = subprocess.run(cmd + [url], capture_output=True, timeout=timeout + 2, check=False)
    if r.returncode != 0 or not r.stdout:
        raise OSError(f'curl exit {r.returncode}')
    return json.loads(r.stdout.decode('utf-8', 'replace'))


def pmap(fn, items, timeout=25, pool=None):
    """并行执行 fn(item)，失败的项返回 None。不要在同一个池的任务里再调用它。"""
    items = list(items)
    if not items:
        return []
    futs = [(pool or POOL).submit(fn, x) for x in items]
    out = []
    for f in futs:
        try:
            out.append(f.result(timeout=timeout))
        except Exception:  # noqa: BLE001
            out.append(None)
    return out


def iomap(fn, items, timeout=20):
    """并行跑一组单个上游请求（fn 内部不能再提交线程池任务）。"""
    return pmap(fn, items, timeout=timeout, pool=IO)


class Breaker:
    """熔断：某个数据源出错后暂停使用一段时间，避免每次请求都等超时。"""

    def __init__(self):
        self._down = {}

    def ok(self, name):
        return time.time() >= self._down.get(name, 0)

    def trip(self, name, secs):
        self._down[name] = time.time() + secs


breaker = Breaker()


class Cache:
    """TTL 缓存：同一个 key 并发加载时只请求一次；加载失败时回退到过期值。"""

    def __init__(self):
        self._d = {}
        self._inflight = {}
        self._lock = threading.Lock()

    def peek(self, key):
        ent = self._d.get(key)
        return ent[1] if ent else None

    def fresh(self, key):
        ent = self._d.get(key)
        return ent[1] if ent and ent[0] > time.time() else None

    def set(self, key, value, ttl):
        with self._lock:
            self._d[key] = (time.time() + ttl, value)

    def drop(self, key):
        with self._lock:
            self._d.pop(key, None)

    def get(self, key, ttl, loader):
        with self._lock:
            ent = self._d.get(key)
            if ent and ent[0] > time.time():
                return ent[1]
            fut = self._inflight.get(key)
            owner = fut is None
            if owner:
                fut = Future()
                self._inflight[key] = fut
        if not owner:
            return fut.result(timeout=40)
        try:
            val = loader()
            real_ttl = ttl(val) if callable(ttl) else ttl
            with self._lock:
                self._d[key] = (time.time() + real_ttl, val)
            fut.set_result(val)
            return val
        except Exception as e:
            if ent is not None:
                fut.set_result(ent[1])
                return ent[1]
            fut.set_exception(e)
            raise
        finally:
            with self._lock:
                self._inflight.pop(key, None)


cache = Cache()


def read_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{threading.get_ident()}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)


def disk_cached(name, max_age, loader):
    """磁盘缓存（重启后仍可用）；过期后重新加载，失败则继续用旧文件。"""
    path = os.path.join(CACHE_DIR, name)
    try:
        age = time.time() - os.path.getmtime(path)
    except OSError:
        age = None
    if age is not None and age < max_age:
        val = read_json(path)
        if val is not None:
            return val
    try:
        val = loader()
    except Exception:
        val = read_json(path)
        if val is None:
            raise
        return val
    write_json(path, val)
    return val


def fnum(v, default=None):
    try:
        if v in (None, '', '-', '--'):
            return default
        return float(str(v).replace('%', '').replace(',', ''))
    except (TypeError, ValueError):
        return default


def weekdays_between(a, b):
    """a、b 之间（不含两端）是否存在工作日。"""
    d = a + timedelta(days=1)
    while d < b:
        if d.weekday() < 5:
            return True
        d += timedelta(days=1)
    return False

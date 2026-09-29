export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  let r;
  try {
    r = await fetch('/api' + path, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', 'X-FL': '1' } : { 'X-FL': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, '网络连接失败');
  }
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  if (!r.ok) {
    if (r.status === 401 && path !== '/login') window.dispatchEvent(new Event('fl:unauthorized'));
    throw new ApiError(r.status, (data && data.error) || `请求失败（${r.status}）`);
  }
  return data;
}

// 同一只基金的资料在一次会话里只取一次（除非强制刷新）
const detailCache = new Map();
export function fundDetail(code, force = false) {
  if (force || !detailCache.has(code)) {
    const p = api('/funds/' + code).catch((e) => {
      detailCache.delete(code);
      throw e;
    });
    detailCache.set(code, p);
  }
  return detailCache.get(code);
}

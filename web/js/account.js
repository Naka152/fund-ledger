// 账户：登录 / 注册、修改密码、用户管理（管理员）
import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { api } from './api.js';
import { Seg, Toggle, toast } from './ui.js';

const when = (s) => (s ? s.slice(0, 16).replace('T', ' ') : '—');

export function Login({ openSignup, onDone }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (signup && password !== confirm) return setErr('两次输入的密码不一致');
    setBusy(true);
    try {
      const r = await api(signup ? '/signup' : '/login', { method: 'POST', body: { username: username.trim(), password, remember } });
      onDone(r.user);
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };

  return html`<div class="gate"><form class="gate-box" onSubmit=${submit}>
    <h1>基金记账簿</h1><div class="en">FUND LEDGER</div>
    ${openSignup
      ? html`<div style=${{ margin: '18px 0 4px' }}><${Seg} options=${[{ value: 'login', label: '登录' }, { value: 'signup', label: '注册新账户' }]}
          value=${mode} onChange=${(v) => { setMode(v); setErr(''); }} /></div>`
      : html`<p>登录你的基金账本。</p>`}
    <div class="field">
      <label class="field-label" for="lg-user">用户名</label>
      <input id="lg-user" class="input text" autocomplete="username" autocapitalize="off" spellcheck="false" value=${username}
        onInput=${(e) => setUsername(e.target.value)} autofocus />
    </div>
    <div class="field">
      <label class="field-label" for="lg-pass">密码</label>
      <input id="lg-pass" class="input text" type="password" autocomplete=${signup ? 'new-password' : 'current-password'}
        value=${password} onInput=${(e) => setPassword(e.target.value)} />
    </div>
    ${signup
      ? html`<div class="field">
          <label class="field-label" for="lg-pass2">再输一次密码</label>
          <input id="lg-pass2" class="input text" type="password" autocomplete="new-password" value=${confirm}
            onInput=${(e) => setConfirm(e.target.value)} />
          <div class="field-hint">用户名 2–32 位，可用字母、数字、汉字和 _ . -；密码至少 6 位。</div>
        </div>`
      : null}
    <div class="field"><${Toggle} on=${remember} onChange=${setRemember}>在这台设备上保持登录（30 天）</${Toggle}></div>
    ${err ? html`<div class="callout warn">${err}</div>` : null}
    <button class="btn primary block" disabled=${busy || !username.trim() || !password}>${busy ? '请稍候…' : signup ? '注册并登录' : '登录'}</button>
    ${!openSignup ? html`<p class="small muted">还没有账户？请联系管理员开通。</p>` : null}
  </form></div>`;
}

export function AccountBlock({ user, auth }) {
  const [old, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    location.replace('/');
  };
  const change = async (e) => {
    e.preventDefault();
    if (pw !== pw2) return toast('两次输入的新密码不一致', 'error');
    setBusy(true);
    try {
      await api('/account/password', { method: 'POST', body: { old, new: pw } });
      toast('密码已修改，其他设备需要重新登录');
      setOld('');
      setPw('');
      setPw2('');
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy(false);
  };
  if (!auth) return html`<div class="block note">本机调试模式，没有启用登录。</div>`;
  return html`<div class="block">
    <div class="block-title"><h4>账户</h4><button class="linkish" onClick=${logout}>退出登录</button></div>
    <p class="note">已登录：<b>${user.username}</b>${user.admin ? '（管理员）' : ''}</p>
    <form onSubmit=${change}>
      <input class="input text" type="text" autocomplete="username" value=${user.username} hidden />
      <div class="row3">
        <div class="field"><label class="field-label" for="pw-old">原密码</label>
          <input id="pw-old" class="input text" type="password" autocomplete="current-password" value=${old} onInput=${(e) => setOld(e.target.value)} /></div>
        <div class="field"><label class="field-label" for="pw-new">新密码</label>
          <input id="pw-new" class="input text" type="password" autocomplete="new-password" value=${pw} onInput=${(e) => setPw(e.target.value)} /></div>
        <div class="field"><label class="field-label" for="pw-new2">再输一次</label>
          <input id="pw-new2" class="input text" type="password" autocomplete="new-password" value=${pw2} onInput=${(e) => setPw2(e.target.value)} /></div>
      </div>
      <button class="btn small" disabled=${busy || !old || pw.length < 6}>修改密码</button>
      <span class="field-hint" style=${{ marginLeft: '10px' }}>至少 6 位；修改后其他设备会被退出</span>
    </form>
  </div>`;
}

export function AdminBlock({ me }) {
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [admin, setAdmin] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  const [resetPw, setResetPw] = useState('');
  const load = () => api('/admin/users').then(setData).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
  }, []);
  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg);
      load();
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  };
  const add = async (e) => {
    e.preventDefault();
    const ok = await act(() => api('/admin/users', { method: 'POST', body: { username: name.trim(), password: pw, admin } }), `已添加用户 ${name.trim()}`);
    if (ok) {
      setName('');
      setPw('');
      setAdmin(false);
    }
  };
  if (!data) return html`<div class="block"><div class="block-title"><h4>用户管理</h4></div><p class="muted small">载入中…</p></div>`;
  return html`<div class="block">
    <div class="block-title"><h4>用户管理</h4><span class="muted small">${data.users.length} 个账户</span></div>
    <${Toggle} on=${!!data.settings.openSignup} onChange=${(v) => act(() => api('/admin/settings', { method: 'PUT', body: { openSignup: v } }), v ? '已开放注册' : '已关闭注册')}>
      允许任何人在登录页自行注册
    </${Toggle}>
    <table class="mini" style=${{ marginTop: '12px' }}>
      <thead><tr><th>用户名</th><th>创建</th><th>最近登录</th><th></th></tr></thead>
      <tbody>${data.users.map((u) => html`<tr>
        <td><b>${u.username}</b>${u.admin ? html` <span class="tag">管理员</span>` : null}</td>
        <td class="num">${when(u.created).slice(0, 10)}</td>
        <td class="num">${when(u.lastLogin)}</td>
        <td>${u.id === me.id
          ? html`<span class="muted small">当前账户</span>`
          : html`<span class="row-actions"><button class="linkish small" onClick=${() => { setResetFor(resetFor === u.id ? null : u.id); setResetPw(''); }}>重设密码</button>
            <button class="linkish small" onClick=${() => confirm(`删除用户 ${u.username}？它的持仓数据会移到服务器的 deleted 目录保留。`) && act(() => api('/admin/users/' + u.id, { method: 'DELETE' }), `已删除 ${u.username}`)}>删除</button></span>`}</td>
      </tr>
      ${resetFor === u.id
        ? html`<tr><td colspan="4">
            <form style=${{ display: 'flex', gap: '8px', padding: '6px 0' }} onSubmit=${(e) => { e.preventDefault(); act(() => api('/admin/users/' + u.id, { method: 'PATCH', body: { password: resetPw } }), `已重设 ${u.username} 的密码`).then((ok) => ok && setResetFor(null)); }}>
              <input class="input text" type="password" autocomplete="new-password" placeholder="新密码（至少 6 位）" value=${resetPw} onInput=${(e) => setResetPw(e.target.value)} />
              <button class="btn small" disabled=${resetPw.length < 6}>确定</button>
            </form></td></tr>`
        : null}`)}</tbody>
    </table>
    <form onSubmit=${add} style=${{ marginTop: '14px' }}>
      <div class="row2">
        <div class="field"><label class="field-label" for="nu-name">新用户名</label>
          <input id="nu-name" class="input text" autocomplete="off" autocapitalize="off" value=${name} onInput=${(e) => setName(e.target.value)} /></div>
        <div class="field"><label class="field-label" for="nu-pw">初始密码</label>
          <input id="nu-pw" class="input text" type="password" autocomplete="new-password" value=${pw} onInput=${(e) => setPw(e.target.value)} /></div>
      </div>
      <div style=${{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <${Toggle} on=${admin} onChange=${setAdmin}>设为管理员</${Toggle}>
        <button class="btn small" disabled=${!name.trim() || pw.length < 6}>添加用户</button>
      </div>
    </form>
  </div>`;
}

const $ = (s) => document.querySelector(s);
const msg = (t) => ($('#msg').textContent = t);
const next = () => {
  const n = new URLSearchParams(location.search).get('next') || '/';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';
};

const ERRORS = {
  EPASSWORD: '密码不对。',
  ECODE: '设置码不对。',
  ESHORT: '密码至少 8 个字符。',
  EDONE: '密码已经设置过了，请直接登录。',
  ESETUP: '还没有设置密码。',
};

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (j.ok) return location.replace(next());
  if (j.code === 'EWAIT' || j.wait) return msg(`${ERRORS[j.code] || ''}尝试次数过多，请 ${j.wait} 秒后再试。`);
  msg(ERRORS[j.code] || '登录失败。');
}

async function init() {
  const s = await (await fetch('/api/auth')).json();
  if (!s.enabled || s.loggedIn) return location.replace(next());
  const form = s.needsSetup ? $('#setup') : $('#login');
  form.hidden = false;
  form.querySelector('input').focus();
  $('#login').onsubmit = (e) => {
    e.preventDefault();
    post('/api/login', { password: $('#pw').value });
  };
  $('#setup').onsubmit = (e) => {
    e.preventDefault();
    if ($('#pw1').value !== $('#pw2').value) return msg('两次输入的密码不一样。');
    post('/api/setup', { code: $('#code').value, password: $('#pw1').value });
  };
}

init().catch(() => msg('无法连接到服务器。'));

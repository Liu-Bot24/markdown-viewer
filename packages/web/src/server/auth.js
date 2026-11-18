// Optional single-user login (MDV_AUTH=on). Off by default: then every request passes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COOKIE = 'mdv_session';
export const MIN_PASSWORD = 8;
const IDLE_MS = 14 * 24 * 3600 * 1000;
const ABSOLUTE_MS = 90 * 24 * 3600 * 1000;
const FREE_FAILURES = 5;
const MAX_DELAY_S = 300;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password).normalize('NFC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join(':');
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const want = Buffer.from(keyB64, 'base64');
  let got;
  try {
    got = crypto.scryptSync(String(password).normalize('NFC'), Buffer.from(saltB64, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
  } catch {
    return false;
  }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.enabled = cfg.auth === 'on';
    this.file = path.join(cfg.stateDir, 'auth.json');
    this.data = { passwordHash: '', sessions: {} };
    this.failures = 0;
    this.blockedUntil = 0;
    this.setupCode = null;
    this.secure = /^https:/i.test(cfg.publicUrl || '');
  }

  init() {
    if (!this.enabled) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { passwordHash: d.passwordHash || '', sessions: d.sessions || {} };
    } catch {
      /* first start */
    }
    if (!this.passwordHash) {
      this.setupCode = crypto.randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '7').slice(0, 8);
      this.log.info(`登录已启用，尚未设置密码。首次设置码：${this.setupCode}（在页面上输入它来设置密码；设置后作废）`);
    }
  }

  get passwordHash() {
    return this.cfg.passwordHash || this.data.passwordHash;
  }

  get needsSetup() {
    return this.enabled && !this.passwordHash;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.warn('无法保存登录状态：' + e.message);
    }
  }

  /** Session for a request, or null. Always truthy when auth is off. */
  check(req) {
    if (!this.enabled) return { anonymous: true };
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const k = sha(token);
    const s = this.data.sessions[k];
    if (!s) return null;
    const now = Date.now();
    if (now - s.c > ABSOLUTE_MS || now - s.l > IDLE_MS) {
      delete this.data.sessions[k];
      this.save();
      return null;
    }
    if (now - s.l > 3600 * 1000) {
      s.l = now;
      this.save();
    }
    return s;
  }

  /** Seconds the caller must still wait before another attempt (global: the real client IP is often hidden by a tunnel). */
  waitSeconds() {
    return Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000));
  }

  noteFailure(ip, what) {
    this.failures++;
    if (this.failures >= FREE_FAILURES) {
      const delay = Math.min(MAX_DELAY_S, 2 ** (this.failures - FREE_FAILURES + 1));
      this.blockedUntil = Date.now() + delay * 1000;
    }
    this.log.warn(`${what}失败（来自 ${ip}，连续 ${this.failures} 次）`);
  }

  newSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.data.sessions[sha(token)] = { c: now, l: now };
    this.save();
    return token;
  }

  cookie(token, maxAgeMs = ABSOLUTE_MS) {
    const bits = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (this.secure) bits.push('Secure');
    return bits.join('; ');
  }

  clearCookie() {
    return this.cookie('', 0);
  }

  /** Returns { ok, token } or { ok: false, status, code, wait }. */
  login(password, ip) {
    const wait = this.waitSeconds();
    if (wait) return { ok: false, status: 429, code: 'EWAIT', wait };
    if (!this.passwordHash) return { ok: false, status: 409, code: 'ESETUP' };
    if (!verifyPassword(password, this.passwordHash)) {
      this.noteFailure(ip, '登录');
      return { ok: false, status: 401, code: 'EPASSWORD', wait: this.waitSeconds() };
    }
    this.failures = 0;
    this.blockedUntil = 0;
    this.log.info(`登录成功（来自 ${ip}）`);
    return { ok: true, token: this.newSession() };
  }

  setup(code, password, ip) {
    const wait = this.waitSeconds();
    if (wait) return { ok: false, status: 429, code: 'EWAIT', wait };
    if (!this.needsSetup) return { ok: false, status: 409, code: 'EDONE' };
    const a = Buffer.from(String(code || '').trim().toUpperCase());
    const b = Buffer.from(this.setupCode);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      this.noteFailure(ip, '设置密码');
      return { ok: false, status: 401, code: 'ECODE', wait: this.waitSeconds() };
    }
    if (String(password || '').length < MIN_PASSWORD) return { ok: false, status: 400, code: 'ESHORT' };
    this.data.passwordHash = hashPassword(password);
    this.data.sessions = {};
    this.setupCode = null;
    this.failures = 0;
    this.log.info(`密码已设置（来自 ${ip}），设置码已作废`);
    return { ok: true, token: this.newSession() };
  }

  logout(req, all = false) {
    if (all) this.data.sessions = {};
    else {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) delete this.data.sessions[sha(token)];
    }
    this.save();
  }
}

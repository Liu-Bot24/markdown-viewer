// Deployment settings, all from environment variables. Defaults are neutral: no
// paths, addresses or accounts beyond the container's own conventional mount points.
import path from 'node:path';

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(v) {
  return /^(1|true|yes|on)$/i.test(String(v || '').trim());
}

function num(v, def) {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? def : n;
}

/**
 * MDV_INDEX_SCHEDULE: "off" (default), "daily@HH:MM" in the container's time zone (TZ),
 * or "every:<hours>h". Anything else is off.
 */
export function parseSchedule(v) {
  const s = String(v || 'off').trim().toLowerCase();
  let m = /^daily@(\d{1,2}):(\d{2})$/.exec(s);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { kind: 'daily', hour: Number(m[1]), minute: Number(m[2]) };
  m = /^every:(\d+(?:\.\d+)?)h$/.exec(s);
  if (m && Number(m[1]) > 0) return { kind: 'every', hours: Number(m[1]) };
  return { kind: 'off' };
}

/** When the next scheduled check is due, in ms since the epoch; null when off. */
export function nextScheduled(sc, now = Date.now()) {
  if (sc.kind === 'every') return now + sc.hours * 3600 * 1000;
  if (sc.kind !== 'daily') return null;
  const next = new Date(now);
  next.setHours(sc.hour, sc.minute, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function loadConfig(env = process.env) {
  const auth = String(env.MDV_AUTH || 'off').trim().toLowerCase() === 'on' ? 'on' : 'off';
  return {
    port: num(env.MDV_PORT, 8080),
    host: env.MDV_HOST || '0.0.0.0',
    rootsDir: path.resolve(env.MDV_ROOTS_DIR || '/roots'),
    stateDir: path.resolve(env.MDV_STATE_DIR || '/state'),
    cacheDir: path.resolve(env.MDV_CACHE_DIR || '/cache'),
    auth,
    passwordHash: (env.MDV_PASSWORD_HASH || '').trim(),
    publicUrl: (env.MDV_PUBLIC_URL || '').trim(),
    trustedProxy: list(env.MDV_TRUSTED_PROXY),
    writableRoots: list(env.MDV_WRITABLE_ROOTS),
    disableWrite: bool(env.MDV_DISABLE_WRITE),
    recheckIdleHours: Math.max(0, num(env.MDV_RECHECK_IDLE_HOURS, 24)),
    indexSchedule: parseSchedule(env.MDV_INDEX_SCHEDULE),
    // image thumbnails for chat previews: cache limit in GB, 0 turns thumbnails off
    thumbCacheBytes: Math.max(0, num(env.MDV_THUMB_CACHE_GB, 10)) * 1024 ** 3,
    // hardware video transcoding: "auto" uses /dev/dri when present, "off" never transcodes
    transcode: String(env.MDV_TRANSCODE || 'auto').trim().toLowerCase(),
    ffmpeg: env.MDV_FFMPEG || 'ffmpeg',
    staticDir: env.MDV_STATIC_DIR ? path.resolve(env.MDV_STATIC_DIR) : null,
    // test hooks: skip the index entirely
    noIndex: bool(env.MDV_NO_INDEX),
  };
}

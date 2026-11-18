// Privacy scan before publishing: looks for local paths, private addresses, account ids,
// e-mail addresses and phone numbers, plus every term in a local, git-ignored deny list
// (.privacy-denylist, one term per line). Scans the tracked files, optionally every commit
// reachable from any branch, tag or reflog entry (--history), and a Docker image.
//
// usage: node scripts/privacy-scan.mjs [--history] [--image <name:tag>] [--files <path>...]
// exit code 1 when anything is found.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const want = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i === -1 ? null : args[i + 1];
};

// Public rules. Placeholders such as <folder> and the synthetic test ids are allowed;
// X: is the drive the tests use for made-up Windows paths.
export const RULES = [
  { name: 'Windows user folder', re: /[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|<)[^\\/\s"'`<>]+/g },
  { name: 'Windows path on a data drive', re: /\b[D-WYZd-wyz]:[\\/]+(?![<*])(?:[^\s"'`<>|]*[一-鿿][^\s"'`<>|]*|work[\\/][^\s"'`<>|]+)/g },
  { name: 'NAS storage path', re: /\/tmp\/zfsv3\/(?!<)[^\s"'`]+|\/data_[a-z0-9]+\/[^\s"'`]+/g },
  { name: 'private IPv4 address', re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'e-mail address', re: /\b(?![a-z]@[a-z]\.[a-z]{2,3}\b)[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)\b|anthropic\.com\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'mainland mobile number', re: /(?<![\d.])1[3-9]\d{9}(?!\d)/g },
  { name: 'WeChat account id', re: /\bwxid_(?!test|x+\b|<|[a-z]*peer\d*\b|(?:zhangsan|lisi|wangwu)\b)[a-z0-9]{6,}\b/gi },
  { name: 'chatroom id', re: /\b\d{8,}@chatroom\b/g },
  { name: 'access token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,}|xox[abpr]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g },
  { name: 'private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { name: 'password hash', re: /\bscrypt:\d+:\d+:\d+:[A-Za-z0-9+/=]{16,}:[A-Za-z0-9+/=]{32,}/g },
];

function denylist() {
  const f = path.join(root, '.privacy-denylist');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    // one character, a bare number or a short Latin word identifies nobody
    .filter((s) => s.length >= 2 && !/^[\d\s\p{P}\p{S}]+$/u.test(s) && !(/^[\x20-\x7e]+$/.test(s) && s.length < 4));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ASCII terms match whole words (a name inside an English word is not a hit); others match anywhere. */
function termRegex(t) {
  if (/^[\x20-\x7e]+$/.test(t)) return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(t)}(?![A-Za-z0-9_])`, 'gi');
  return new RegExp(escapeRe(t), 'gi');
}

/** Percent-encoded runs decoded in place (a path inside a file:// URL), lines kept apart. */
function decodePercent(text) {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (s) => {
    try {
      return decodeURIComponent(s).replace(/[\r\n]/g, ' ');
    } catch {
      return s;
    }
  });
}

/** Findings in one text: [{ rule, match, line }]. */
export function scanText(text, terms = []) {
  const out = [];
  const seen = new Set();
  const scan = (t) => {
    const lineOf = (i) => t.slice(0, i).split('\n').length;
    const push = (f) => {
      const k = `${f.rule}|${f.line}|${f.match}`;
      if (!seen.has(k)) seen.add(k), out.push(f);
    };
    for (const r of RULES) {
      for (const m of t.matchAll(r.re)) push({ rule: r.name, match: m[0], line: lineOf(m.index) });
    }
    for (const term of terms) {
      for (const m of t.matchAll(termRegex(term))) push({ rule: 'deny list', match: mask(term), line: lineOf(m.index) });
    }
  };
  scan(text);
  const decoded = decodePercent(text);
  if (decoded !== text) scan(decoded);
  // a rule's match may contain a private term (a path with a contact's name): never print it
  for (const f of out) if (f.rule !== 'deny list') for (const t of terms) f.match = f.match.replace(termRegex(t), mask(t));
  return out;
}

const mask = (s) => (s.length <= 2 ? '*'.repeat(s.length) : s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]);
const isText = (buf) => !buf.subarray(0, 8000).includes(0);

function report(where, findings) {
  for (const f of findings) console.log(`${where}:${f.line}: [${f.rule}] ${f.rule === 'deny list' ? f.match : f.match.slice(0, 80)}`);
  return findings.length;
}

// files that document the rules themselves
const SELF = new Set(['scripts/privacy-scan.mjs', 'test/unit/privacy-scan.test.mjs']);

function scanWorktree(terms, files) {
  const list = files.length ? files : execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  let n = 0;
  for (const rel of list) {
    const self = SELF.has(rel.replace(/\\/g, '/'));
    const p = path.resolve(root, rel);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    n += report(rel, scanText(rel + '\n', terms).map((f) => ({ ...f, line: 0 })));
    const buf = fs.readFileSync(p);
    if (isText(buf)) n += report(rel, scanText(buf.toString('utf8'), terms).filter((f) => !self || f.rule === 'deny list'));
  }
  return n;
}

/**
 * Every commit reachable from any ref or reflog entry: each commit message, every file path
 * and every file version (once, named by the first commit that has it). The files that
 * document the rules are checked against the deny list only.
 * Returns { commits, versions, findings: [{ where, rule, match, line }] }.
 */
export function historyFindings(dir, terms = []) {
  const git = (argv, input) => {
    const r = spawnSync('git', argv, { cwd: dir, input, maxBuffer: 1024 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${argv[0]}: ${r.stderr}`);
    return r.stdout;
  };
  const findings = [];
  const add = (where, list) => findings.push(...list.map((f) => ({ where, ...f })));
  const commits = git(['rev-list', '--all', '--reflog', '--reverse']).toString().split('\n').filter(Boolean);
  const blobs = new Map(); // id -> { where, self }
  const paths = new Set();
  for (const c of commits) {
    const at = 'commit ' + c.slice(0, 7);
    // commit authorship is the publisher's own choice: only the message is scanned
    add(at + ' message', scanText(git(['log', '-1', '--format=%B', c]).toString('utf8'), terms));
    for (const ent of git(['ls-tree', '-r', '-z', c]).toString('utf8').split('\0').filter(Boolean)) {
      const tab = ent.indexOf('\t');
      const [, type, id] = ent.slice(0, tab).split(' ');
      const rel = ent.slice(tab + 1);
      if (!paths.has(rel)) {
        paths.add(rel);
        add(`${at}:${rel}`, scanText(rel + '\n', terms).map((f) => ({ ...f, line: 0 })));
      }
      if (type !== 'blob') continue;
      const self = SELF.has(rel);
      const b = blobs.get(id);
      if (!b) blobs.set(id, { where: `${at}:${rel}`, self });
      else if (b.self && !self) Object.assign(b, { where: `${at}:${rel}`, self: false });
    }
  }
  const ids = [...blobs.keys()];
  const out = ids.length ? git(['cat-file', '--batch'], ids.join('\n') + '\n') : Buffer.alloc(0);
  let i = 0;
  for (const id of ids) {
    const nl = out.indexOf(0x0a, i);
    const size = Number(out.subarray(i, nl).toString().split(' ')[2]);
    const buf = out.subarray(nl + 1, nl + 1 + size);
    i = nl + 2 + size;
    if (!isText(buf)) continue;
    const b = blobs.get(id);
    const list = scanText(buf.toString('utf8'), terms);
    add(b.where, b.self ? list.filter((f) => f.rule === 'deny list') : list);
  }
  return { commits: commits.length, versions: ids.length, findings };
}

function scanHistory(terms) {
  const h = historyFindings(root, terms);
  console.log(`git history: ${h.commits} commits, ${h.versions} file versions`);
  for (const f of h.findings) report(f.where, [f]);
  return h.findings.length;
}

function scanImage(image, terms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-image-'));
  try {
    // labels, environment, entrypoint and the build history anyone can read
    let meta = execFileSync('docker', ['image', 'inspect', image]).toString('utf8');
    meta += '\n' + execFileSync('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', image]).toString('utf8');
    const n0 = report('image:inspect+history', scanText(meta, terms));
    const tar = path.join(dir, 'image.tar');
    execFileSync('docker', ['save', '-o', tar, image]);
    execFileSync('tar', ['-xf', tar, '-C', dir]);
    let n = n0;
    // every layer: only the application folder and image metadata are ours
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tar') && p !== tar) {
          const out = path.join(dir, 'x' + Math.random().toString(16).slice(2));
          fs.mkdirSync(out);
          spawnSync('tar', ['-xf', p, '-C', out, 'app'], { stdio: 'ignore' });
          if (fs.existsSync(path.join(out, 'app'))) n += scanTree(path.join(out, 'app'), terms, 'image:/app');
        } else if (e.name.endsWith('.json')) n += report('image:' + e.name, scanText(fs.readFileSync(p, 'utf8'), terms));
      }
    };
    walk(dir);
    return n;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function scanTree(d, terms, label) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue; // third-party packages
      n += scanTree(p, terms, label + '/' + e.name);
    } else {
      const buf = fs.readFileSync(p);
      if (isText(buf)) n += report(label + '/' + e.name, scanText(buf.toString('utf8'), terms));
    }
  }
  return n;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('privacy-scan.mjs')) {
  const terms = denylist();
  const fi = args.indexOf('--files');
  const files = fi === -1 ? [] : args.slice(fi + 1);
  let n = scanWorktree(terms, files);
  if (want('--history')) n += scanHistory(terms);
  const image = valueOf('--image');
  if (image) n += scanImage(image, terms);
  console.log(n ? `privacy scan: ${n} finding(s)` : `privacy scan: clean (${terms.length} deny-list terms)`);
  process.exit(n ? 1 : 0);
}

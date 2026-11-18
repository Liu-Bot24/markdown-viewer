// End-to-end self test: runs the steps of a JSON spec inside the real window,
// checks expectations, saves screenshots and writes report.json, then exits.
//
// spec: { outDir?, steps: [{ name, do, ...params, expect?: {path: value|{min,max,eq}}, screenshot?: true }] }
// Paths in params may use ${fixtures} (test/fixtures) and ${env:NAME}.

import { app, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function check(result, expect) {
  const failures = [];
  for (const [k, want] of Object.entries(expect || {})) {
    const got = get(result, k);
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if ('min' in want && !(got >= want.min)) failures.push(`${k}=${JSON.stringify(got)} < ${want.min}`);
      if ('max' in want && !(got <= want.max)) failures.push(`${k}=${JSON.stringify(got)} > ${want.max}`);
      if ('eq' in want && got !== want.eq) failures.push(`${k}=${JSON.stringify(got)} != ${JSON.stringify(want.eq)}`);
      if ('includes' in want && !(typeof got === 'string' && got.includes(want.includes))) failures.push(`${k}=${JSON.stringify(got)} lacks ${want.includes}`);
    } else if (got !== want) failures.push(`${k}=${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
  return failures;
}

function expand(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(env:)?([A-Za-z_][\w]*)\}/g, (_m, env, name) => (env ? process.env[name] || '' : vars[name] ?? ''));
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]));
  return value;
}

export async function runSelftest(win, specPath, appRoot) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  // A packaged build has no test files inside; MDV_TEST_ROOT points it at the source checkout.
  const testRoot = process.env.MDV_TEST_ROOT ? path.resolve(process.env.MDV_TEST_ROOT) : appRoot;
  const vars = { fixtures: path.join(testRoot, 'test', 'fixtures'), root: testRoot, tmp: app.getPath('userData') };
  const outDir = path.resolve(testRoot, expand(spec.outDir || 'test/output/selftest', vars));
  fs.mkdirSync(outDir, { recursive: true });
  // screenshots are regenerated on every run; drop the previous run's so none are stale
  for (const f of fs.readdirSync(outDir)) if (/^\d+-.*\.png$/.test(f)) fs.rmSync(path.join(outDir, f));

  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) resolve();
    else win.webContents.once('did-finish-load', resolve);
  });
  // wait for the test hook to be installed by the renderer
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript('!!window.__mdvTest', true).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('selftest: ready'); // scripts/cli-e2e.mjs waits for this before launching second instances
  const report = { spec: specPath, started: new Date().toISOString(), steps: [], passed: 0, failed: 0, skipped: 0 };
  for (const raw of spec.steps) {
    const step = expand(raw, vars);
    const entry = { name: step.name || step.do, do: step.do };
    if ('requires' in step && (!step.requires || !fs.existsSync(step.requires))) {
      entry.skipped = step.requires ? `missing ${step.requires}` : 'not configured';
      report.skipped++;
      report.steps.push(entry);
      continue;
    }
    const t0 = Date.now();
    const { name, expect, screenshot, requires, ...params } = step;
    let result;
    try {
      if (params.do === 'writeFile') {
        // main-side helper: create/modify a file to exercise the watcher
        fs.mkdirSync(path.dirname(params.path), { recursive: true });
        const data = params.base64 != null ? Buffer.from(params.base64, 'base64') : params.content;
        if (params.append) fs.appendFileSync(params.path, data);
        else fs.writeFileSync(params.path, data);
        result = { ok: true };
      } else if (params.do === 'readFile') {
        const b = fs.readFileSync(params.path);
        result = { base64: b.toString('base64'), size: b.length };
      } else if (params.do === 'keys') {
        // real input events: they go through the page and then the menu accelerators, like typing
        win.focus();
        win.webContents.focus();
        for (const k of params.keys) {
          const [mods, key] = k.includes('+') ? [k.split('+').slice(0, -1).map((m) => m.toLowerCase()), k.split('+').pop()] : [[], k];
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
          if (key.length === 1 && !mods.some((m) => m === 'control' || m === 'alt')) win.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
          await new Promise((r) => setTimeout(r, 40));
        }
        await new Promise((r) => setTimeout(r, params.settle ?? 400));
        result = { ok: true };
      } else if (params.do === 'mouse') {
        // real mouse input at a point of the first element matching `selector`: `frac` is
        // [x, y] as fractions of its box, `offset` [x, y] in px from its top-left (wins
        // over frac); `drag` [dx, dy] moves before releasing. `probe` then asks the page
        // for the lightbox state at the release point.
        win.focus();
        win.webContents.focus();
        const sel = JSON.stringify(params.selector);
        const r = await win.webContents.executeJavaScript(`(() => { const n = document.querySelector(${sel}); if (!n) return null; const b = n.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; })()`);
        if (!r) throw new Error(`no element ${params.selector}`);
        const [fx, fy] = params.frac || [0.5, 0.5];
        const x0 = Math.round(params.offset ? r.left + params.offset[0] : r.left + fx * r.width);
        const y0 = Math.round(params.offset ? r.top + params.offset[1] : r.top + fy * r.height);
        const [dx, dy] = params.drag || [0, 0];
        const probe = (x, y) => win.webContents.executeJavaScript(`window.__mdvTest.step(${JSON.stringify({ do: 'lbState', x, y })})`, true);
        const before = params.probe ? await probe(x0, y0) : null;
        const send = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...extra });
        send('mouseMove', x0, y0, { button: undefined });
        send('mouseDown', x0, y0);
        const n = dx || dy ? 8 : 0;
        for (let i = 1; i <= n; i++) {
          await new Promise((res) => setTimeout(res, 16));
          send('mouseMove', Math.round(x0 + (dx * i) / n), Math.round(y0 + (dy * i) / n), { modifiers: ['leftButtonDown'] });
        }
        send('mouseUp', x0 + dx, y0 + dy);
        await new Promise((res) => setTimeout(res, params.settle ?? 300));
        result = { x: x0 + dx, y: y0 + dy };
        if (params.probe) {
          const after = await probe(x0 + dx, y0 + dy);
          Object.assign(result, after, { dScrollLeft: after.scrollLeft - before.scrollLeft, dScrollTop: after.scrollTop - before.scrollTop });
        }
      } else if (params.do === 'closeWindow') {
        win.close(); // the page decides (unsaved edits ask first)
        await new Promise((r) => setTimeout(r, params.settle ?? 1000));
        result = { stillOpen: !win.isDestroyed() && win.isVisible() };
      } else if (params.do === 'windowState') {
        // stands in for the window being covered or minimized while a run is in progress
        if (params.state === 'minimize') win.minimize();
        else win.restore();
        await new Promise((r) => setTimeout(r, params.settle ?? 800));
        result = { minimized: win.isMinimized(), visibility: await win.webContents.executeJavaScript('document.visibilityState') };
      } else if (params.do === 'windowSize') {
        if (win.isMaximized()) win.unmaximize();
        win.setContentSize(params.width, params.height);
        await new Promise((r) => setTimeout(r, 500));
        const [w, h] = win.getContentSize();
        result = { width: w, height: h, cssWidth: await win.webContents.executeJavaScript('innerWidth') };
      } else if (params.do === 'setTheme') {
        nativeTheme.themeSource = params.theme;
        await new Promise((r) => setTimeout(r, 300));
        result = { dark: nativeTheme.shouldUseDarkColors };
      } else {
        // a step that never settles fails by name instead of hanging the run
        const ms = params.stepTimeout ?? 60000;
        let timer;
        result = await Promise.race([
          win.webContents.executeJavaScript(`window.__mdvTest.step(${JSON.stringify(params)})`, true),
          new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`step did not finish within ${ms} ms`)), ms))),
        ]).finally(() => clearTimeout(timer));
      }
    } catch (e) {
      result = { error: String(e) };
    }
    entry.ms = Date.now() - t0;
    entry.result = result;
    const failures = result && result.error ? ['error: ' + result.error] : check(result, expect);
    entry.ok = failures.length === 0;
    if (!entry.ok) entry.failures = failures;
    if (screenshot) {
      await new Promise((r) => setTimeout(r, 250));
      const img = await win.webContents.capturePage();
      const file = path.join(outDir, `${String(report.steps.length + 1).padStart(2, '0')}-${(step.name || step.do).replace(/[^\w.-]+/g, '_')}.png`);
      fs.writeFileSync(file, img.toPNG());
      entry.screenshot = file;
    }
    report[entry.ok ? 'passed' : 'failed']++;
    report.steps.push(entry);
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} (${entry.ms} ms)${entry.ok ? '' : ' ' + failures.join('; ')}`);
  }
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`selftest: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped -> ${path.join(outDir, 'report.json')}`);
  app.exit(report.failed ? 1 : 0);
}

#!/usr/bin/env node
// Runs the same flow on two environments (e.g. staging vs production, or test vs staging) and
// compares, per checkpoint: the DOM, the network calls and full-page screenshots (pixel by pixel).
// Every environment runs `runs` times (default 2): differences between two runs of the SAME
// environment are marked as noise and are not counted as a difference between the environments.
//
// Usage: node twin-diff.js <config.json>
// Writes <outDir>/index.html, summary.json, dom-<checkpoint>.diff and shots/<checkpoint>/*.png.
//
// Read-only by default: only GET, HEAD and OPTIONS requests are let through (on both environments),
// unless a URL matches `allowNonGet`. `allowWrites: true` lets everything through, and is refused
// when one of the environments has `production: true`. See SKILL.md for the config format.
'use strict';

const fs = require('fs');
const path = require('path');
const playwright = require('@playwright/test');

try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
} catch {
  // dotenv is optional: only needed for httpCredentialsEnv
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STEP_TYPES = ['goto', 'click', 'fill', 'press', 'hover', 'select', 'check', 'waitFor', 'checkpoint'];
const FACT_KEYS = ['url', 'status', 'title', 'lang', 'robots', 'canonical', 'description', 'consoleErrors'];
const MAX_DIFF_D = 2500;
const START = Date.now();

// ---------- config ----------

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function loadConfig(file) {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`Cannot read config ${file}: ${e.message}`);
  }
  const errors = [];

  const envs = [];
  if (!Array.isArray(c.environments) || c.environments.length !== 2) {
    errors.push('"environments" must be an array of exactly two { "name", "url", "production" }');
  } else {
    c.environments.forEach((e, i) => {
      const where = `environments[${i}]`;
      const env = { index: i, name: String(e.name ?? ''), slug: slugify(e.name ?? ''), production: e.production };
      if (!env.slug) errors.push(`${where}: "name" is required`);
      if (typeof e.production !== 'boolean') errors.push(`${where}: "production" must be true or false (when in doubt: true)`);
      try {
        const u = new URL(e.url);
        if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
        env.origin = u.origin;
        env.base = u.origin + u.pathname.replace(/\/$/, '');
      } catch {
        errors.push(`${where}: "url" must be an http(s) URL`);
      }
      if (e.httpCredentialsEnv) {
        const [user, pass] = e.httpCredentialsEnv;
        if (!process.env[user] || !process.env[pass]) errors.push(`${where}: ${user} or ${pass} is not set in .env`);
        else env.creds = { username: process.env[user], password: process.env[pass] };
      }
      envs.push(env);
    });
    if (envs[0].slug && envs[0].slug === envs[1].slug) errors.push('the two environments need different names');
    if (envs[0].base && envs[0].base === envs[1].base) errors.push('the two environments have the same URL');
  }

  const allowWrites = c.allowWrites === true;
  if (allowWrites && envs.some((e) => e.production !== false)) {
    errors.push('"allowWrites" is refused: one of the environments is (or may be) production');
  }

  if (!c.outDir) errors.push('"outDir" is required');
  else if (fs.existsSync(c.outDir)) errors.push(`outDir ${c.outDir} already exists`);
  if (!['chromium', 'firefox', 'webkit'].includes(c.browser ?? 'chromium')) errors.push('"browser" must be chromium, firefox or webkit');
  const runs = c.runs ?? 2;
  if (!Number.isInteger(runs) || runs < 1 || runs > 3) errors.push('"runs" must be 1, 2 or 3');

  const steps = Array.isArray(c.steps) ? c.steps : [];
  if (!steps.length) errors.push('"steps" must be a non-empty array');
  const names = new Set();
  steps.forEach((s, i) => {
    const type = STEP_TYPES.find((t) => t in s);
    if (!type) return errors.push(`step ${i + 1}: unknown step ${JSON.stringify(s)}`);
    if (type === 'goto' && (typeof s.goto !== 'string' || !s.goto.startsWith('/'))) {
      errors.push(`step ${i + 1}: goto must be a relative path starting with "/"`);
    }
    if (type === 'checkpoint') {
      if (!/^[a-z0-9-]+$/.test(s.checkpoint)) errors.push(`step ${i + 1}: checkpoint name must be kebab-case`);
      if (names.has(s.checkpoint)) errors.push(`step ${i + 1}: duplicate checkpoint "${s.checkpoint}"`);
      names.add(s.checkpoint);
    }
  });
  if (steps.length && !names.size) errors.push('add at least one { "checkpoint": "<name>" } step');
  if (steps.length && !('goto' in steps[0])) errors.push('the first step must be a goto');
  if (errors.length) fail(`Invalid config:\n- ${errors.join('\n- ')}`);

  return {
    name: c.name || 'flow',
    lang: c.lang === 'en' ? 'en' : 'nl',
    outDir: c.outDir,
    envs,
    allowWrites,
    browser: c.browser ?? 'chromium',
    viewport: c.viewport ?? { width: 1280, height: 720 },
    locale: c.locale ?? 'nl-BE',
    timezoneId: c.timezoneId ?? 'Europe/Brussels',
    clock: c.clock === false ? null : c.clock ? new Date(c.clock) : new Date(START),
    runs,
    pixelThreshold: c.pixelThreshold ?? 0,
    fullPage: c.fullPage ?? true,
    timeout: c.timeout ?? 15000,
    mask: c.mask ?? [],
    ignoreNetwork: c.ignoreNetwork ?? [],
    allowNonGet: c.allowNonGet ?? [],
    hostAliases: c.hostAliases ?? {},
    steps,
  };
}

// Unique value per environment and run, for "{uid}" in goto and value (e.g. unique e-mail addresses).
const uidFor = (env, run) => `tw${START.toString(36)}${env.index}${run}`;
const expand = (s, uid) => (typeof s === 'string' ? s.split('{uid}').join(uid) : s);

// ---------- normalisation ----------

// Makes values comparable between environments: own origin -> {app}, aliased hosts -> alias,
// the run's uid -> {uid}, build hashes in asset names, cache busters and build ids -> placeholders.
function makeNormalizer(cfg, env, uid) {
  const reps = [[uid, '{uid}'], [env.origin, '{app}']];
  for (const [alias, hosts] of Object.entries(cfg.hostAliases)) {
    if (hosts[env.name]) reps.push([hosts[env.name], alias]);
  }
  return (s) => {
    if (s == null) return s;
    s = String(s);
    for (const [from, to] of reps) s = s.split(from).join(to);
    s = s.replace(/([.\-_~/])([A-Za-z0-9_-]{8,})(?=\.(?:m?js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|json|map)\b)/g,
      (m, p, t) => (/\d/.test(t) ? `${p}[hash]` : m));
    s = s.replace(/([?&][\w.-]+=)([A-Za-z0-9_-]{8,})(?=[&"'\s]|$)/g, (m, p, t) => (/\d/.test(t) ? `${p}[x]` : m));
    s = s.replace(/\/([A-Za-z0-9_-]{16,})(?=\/)/g, (m, t) => (/\d/.test(t) && /[A-Za-z]/.test(t) ? '/[id]' : m));
    return s;
  };
}

// ---------- flow ----------

function locate(page, spec) {
  let loc;
  const exact = spec.exact ?? false;
  if (spec.role) loc = page.getByRole(spec.role, spec.name !== undefined ? { name: spec.name, exact } : {});
  else if (spec.label) loc = page.getByLabel(spec.label, { exact });
  else if (spec.placeholder) loc = page.getByPlaceholder(spec.placeholder, { exact });
  else if (spec.text) loc = page.getByText(spec.text, { exact });
  else if (spec.testId) loc = page.getByTestId(spec.testId);
  else if (spec.css) loc = page.locator(spec.css);
  else throw new Error(`Unknown locator ${JSON.stringify(spec)}`);
  return spec.nth !== undefined ? loc.nth(spec.nth) : loc;
}

async function runStep(page, step, base, uid) {
  const value = expand(step.value, uid);
  if ('goto' in step) await page.goto(base + expand(step.goto, uid), { waitUntil: 'load' });
  else if ('click' in step) await locate(page, step.click).click();
  else if ('fill' in step) await locate(page, step.fill).fill(String(value ?? ''));
  else if ('press' in step) await (step.target ? locate(page, step.target).press(step.press) : page.keyboard.press(step.press));
  else if ('hover' in step) await locate(page, step.hover).hover();
  else if ('select' in step) await locate(page, step.select).selectOption(value);
  else if ('check' in step) await locate(page, step.check).check();
  else if ('waitFor' in step) await locate(page, step.waitFor).waitFor();
}

function describeStep(step) {
  const type = STEP_TYPES.find((t) => t in step);
  return `${type} ${JSON.stringify(step[type])}${step.value !== undefined ? ` = ${JSON.stringify(step.value)}` : ''}`;
}

// Runs in the page: an indented outline of the DOM with the attributes that matter and the text.
function domDigest() {
  const KEEP = ['id', 'name', 'type', 'role', 'href', 'src', 'action', 'method', 'alt', 'title', 'rel', 'lang',
    'aria-label', 'aria-hidden', 'aria-expanded', 'data-testid', 'placeholder', 'for', 'content', 'property', 'disabled', 'hidden'];
  const OPAQUE = new Set(['svg', 'script', 'style', 'noscript', 'template', 'iframe']);
  const lines = [];
  const clip = (t) => (t.length > 120 ? `${t.slice(0, 120)}…` : t);
  const walk = (el, depth) => {
    const tag = el.tagName.toLowerCase();
    const attrs = [];
    for (const a of KEEP) {
      if (!el.hasAttribute(a)) continue;
      const v = el.getAttribute(a);
      attrs.push(v === '' ? a : `${a}="${clip(v)}"`);
    }
    lines.push(`${'  '.repeat(depth)}<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
    if (OPAQUE.has(tag)) return;
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) lines.push(`${'  '.repeat(depth + 1)}"${clip(t)}"`);
      } else if (node.nodeType === 1) {
        walk(node, depth + 1);
      }
    }
  };
  walk(document.documentElement, 0);
  const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) ?? null;
  return {
    lines,
    facts: {
      title: document.title,
      lang: document.documentElement.getAttribute('lang'),
      robots: attr('meta[name="robots"]', 'content'),
      canonical: attr('link[rel="canonical"]', 'href'),
      description: attr('meta[name="description"]', 'content'),
    },
  };
}

async function runFlow(browser, cfg, env, run) {
  const uid = uidFor(env, run);
  const norm = makeNormalizer(cfg, env, uid);
  const context = await browser.newContext({
    viewport: cfg.viewport,
    deviceScaleFactor: 1,
    locale: cfg.locale,
    timezoneId: cfg.timezoneId,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    httpCredentials: env.creds,
  });
  context.setDefaultTimeout(cfg.timeout);
  context.setDefaultNavigationTimeout(Math.max(cfg.timeout, 30000));
  if (cfg.clock) await context.clock.install({ time: cfg.clock });

  // Read-only guard: block every request that could change data (unless allowWrites).
  const blocked = new WeakSet();
  if (!cfg.allowWrites) {
    await context.route('**/*', (route) => {
      const req = route.request();
      if (SAFE_METHODS.has(req.method()) || cfg.allowNonGet.some((p) => req.url().includes(p))) {
        return route.fallback();
      }
      blocked.add(req);
      return route.abort('blockedbyclient');
    });
  }

  let network = [];
  let consoleErrors = [];
  context.on('response', (res) => {
    const req = res.request();
    network.push({ method: req.method(), url: res.url(), type: req.resourceType(), status: res.status() });
  });
  context.on('requestfailed', (req) => {
    network.push({
      method: req.method(), url: req.url(), type: req.resourceType(),
      status: blocked.has(req) ? 'blocked' : `failed: ${req.failure()?.errorText ?? '?'}`,
    });
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err.message).slice(0, 300)}`));

  const result = { run, uid, checkpoints: {}, error: null };
  const label = `${env.slug}-${run + 1}`;
  for (let i = 0; i < cfg.steps.length; i++) {
    const step = cfg.steps[i];
    try {
      if ('checkpoint' in step) {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        const dir = path.join(cfg.outDir, 'shots', step.checkpoint);
        fs.mkdirSync(dir, { recursive: true });
        const shot = path.join(dir, `${label}.png`);
        await page.screenshot({
          path: shot, fullPage: cfg.fullPage, animations: 'disabled', caret: 'hide',
          mask: cfg.mask.map((s) => page.locator(s)), maskColor: '#FF00FF',
        });
        const dom = await page.evaluate(domDigest);
        const bucket = network;
        const errors = consoleErrors;
        network = [];
        consoleErrors = [];
        const doc = [...bucket].reverse().find((e) => e.type === 'document');
        result.checkpoints[step.checkpoint] = {
          shot,
          dom: dom.lines.map(norm),
          facts: {
            url: norm(page.url()),
            status: doc ? doc.status : null,
            ...Object.fromEntries(Object.entries(dom.facts).map(([k, v]) => [k, norm(v)])),
            consoleErrors: errors.length,
          },
          rawFacts: { url: page.url(), ...dom.facts },
          network: bucket.map((e) => ({ ...e, url: norm(e.url) })),
          console: errors.map(norm),
        };
      } else {
        await runStep(page, step, env.base, uid);
      }
    } catch (e) {
      const shot = path.join(cfg.outDir, 'errors', `${label}.png`);
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      result.error = { step: i + 1, action: describeStep(step), message: String(e.message).split('\n')[0], screenshot: shot };
      break;
    }
  }
  await context.close();
  return result;
}

// ---------- line diff (Myers) ----------

function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_DIFF_D) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return [];
}

function backtrack(trace, a, b) {
  let x = a.length;
  let y = b.length;
  const ops = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const vs = trace[d];
    const get = (k) => vs[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : get(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? { t: '+', line: b[y - 1] } : { t: '-', line: a[x - 1] });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// Fallback for very different documents: which lines occur more often on one side.
function diffMultiset(a, b) {
  const count = new Map();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of b) count.set(l, (count.get(l) ?? 0) - 1);
  const ops = [];
  for (const [line, c] of count) {
    for (let i = 0; i < Math.abs(c); i++) ops.push({ t: c > 0 ? '-' : '+', line });
  }
  return ops;
}

function diffOrApprox(a, b) {
  const ops = diffLines(a, b);
  return ops ? { ops, approx: false } : { ops: diffMultiset(a, b), approx: true };
}

function changedLines(a, b) {
  if (!a || !b) return new Set();
  return new Set(diffOrApprox(a, b).ops.filter((o) => o.t !== ' ').map((o) => o.line.trim()));
}

function compareDom(a1, b1, a2, b2, names) {
  const noise = new Set([...changedLines(a1, a2), ...changedLines(b1, b2)]);
  const { ops, approx } = diffOrApprox(a1, b1);
  let changes = 0;
  let noiseChanges = 0;
  for (const o of ops) {
    if (o.t === ' ') continue;
    o.noise = noise.has(o.line.trim());
    if (o.noise) noiseChanges++;
    else changes++;
  }
  // Unified-style hunks with 2 lines of context around every change.
  const show = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === ' ') return;
    for (let j = Math.max(0, i - 2); j <= Math.min(ops.length - 1, i + 2); j++) show[j] = true;
  });
  const text = [];
  let lineA = 0;
  let lineB = 0;
  let inHunk = false;
  ops.forEach((o, i) => {
    if (show[i]) {
      if (!inHunk) text.push(`@@ ${names[0]} ${lineA + 1} / ${names[1]} ${lineB + 1} @@`);
      inHunk = true;
      text.push(`${o.noise ? '~' : ''}${o.t} ${o.line}`);
    } else {
      inHunk = false;
    }
    if (o.t !== '+') lineA++;
    if (o.t !== '-') lineB++;
  });
  return { changes, noiseChanges, approx, text };
}

// ---------- network ----------

function groupNetwork(entries, ignore) {
  const map = new Map();
  for (const e of entries ?? []) {
    if (ignore.some((p) => e.url.includes(p))) continue;
    const key = `${e.method} ${e.url}`;
    const g = map.get(key) ?? { key, type: e.type, count: 0, statuses: [] };
    g.count++;
    g.statuses.push(String(e.status));
    map.set(key, g);
  }
  for (const g of map.values()) g.statuses.sort();
  return map;
}

const netSig = (g) => (g ? `${g.count}|${g.statuses.join(',')}` : '-');
const netShow = (g) => (g ? `${g.statuses.join(', ')}${g.count > 1 ? ` (${g.count}x)` : ''}` : '—');

function compareNetwork(a1, b1, a2, b2, ignore) {
  const [A, B, A2, B2] = [a1, b1, a2, b2].map((e) => groupNetwork(e, ignore));
  const unstable = (k) => (a2 && netSig(A.get(k)) !== netSig(A2.get(k))) || (b2 && netSig(B.get(k)) !== netSig(B2.get(k)));
  const rows = [];
  for (const key of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(key);
    const b = B.get(key);
    if (netSig(a) === netSig(b)) continue;
    const kind = !b ? 'onlyA' : !a ? 'onlyB' : 'changed';
    rows.push({ kind, request: key, type: (a ?? b).type, a: netShow(a), b: netShow(b), noise: Boolean(unstable(key)) });
  }
  const order = { changed: 0, onlyA: 1, onlyB: 2 };
  rows.sort((x, y) => x.noise - y.noise || order[x.kind] - order[y.kind] || x.request.localeCompare(y.request));
  return rows;
}

// ---------- facts ----------

function compareFacts(a1, b1, a2, b2) {
  return FACT_KEYS.map((key) => {
    const a = a1.facts[key];
    const b = b1.facts[key];
    const noise = (a2 && a2.facts[key] !== a) || (b2 && b2.facts[key] !== b);
    return { key, a, b, same: a === b, noise: Boolean(noise), rawA: a1.rawFacts[key], rawB: b1.rawFacts[key] };
  });
}

// ---------- pixels (computed in a browser canvas) ----------

async function comparePixels(diffPage, files, threshold, outFile) {
  const read = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : null);
  const res = await diffPage.evaluate(async ({ a, b, na, nb, thr }) => {
    const load = async (s) => {
      if (!s) return null;
      const img = new Image();
      img.src = `data:image/png;base64,${s}`;
      await img.decode();
      return img;
    };
    const [A, B, NA, NB] = await Promise.all([a, b, na, nb].map(load));
    const W = Math.max(A.width, B.width);
    const H = Math.max(A.height, B.height);
    const pixels = (img) => {
      if (!img) return null;
      const c = new OffscreenCanvas(W, H);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const [da, db, dna, dnb] = [A, B, NA, NB].map(pixels);
    const t = thr * 255;
    const differs = (p, q, i) => Math.abs(p[i] - q[i]) > t || Math.abs(p[i + 1] - q[i + 1]) > t
      || Math.abs(p[i + 2] - q[i + 2]) > t || Math.abs(p[i + 3] - q[i + 3]) > t;
    const out = new ImageData(W, H);
    const o = out.data;
    let diff = 0;
    let noise = 0;
    let minY = H;
    let maxY = -1;
    let minX = W;
    let maxX = -1;
    for (let i = 0; i < da.length; i += 4) {
      const isDiff = differs(da, db, i);
      const isNoise = (dna && differs(da, dna, i)) || (dnb && differs(db, dnb, i));
      if (isDiff && !isNoise) {
        o[i] = 230; o[i + 1] = 20; o[i + 2] = 60;
        diff++;
        const y = Math.floor(i / 4 / W);
        const x = (i / 4) % W;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      } else if (isNoise) {
        o[i] = 250; o[i + 1] = 190; o[i + 2] = 0;
        if (isDiff) noise++;
      } else {
        const lum = da[i + 3] ? 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2] : 255;
        o[i] = o[i + 1] = o[i + 2] = Math.round(255 - (255 - lum) * 0.3);
      }
      o[i + 3] = 255;
    }
    const c = new OffscreenCanvas(W, H);
    c.getContext('2d').putImageData(out, 0, 0);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return {
      width: W, height: H, a: [A.width, A.height], b: [B.width, B.height],
      diffPixels: diff, noisePixels: noise, totalPixels: W * H,
      diffRows: maxY >= 0 ? [minY, maxY] : null,
      // Bounding box [x0, y0, x1, y1] (inclusive) of all real (non-noise) differing pixels.
      diffBox: maxY >= 0 ? [minX, minY, maxX, maxY] : null,
      png: btoa(bin),
    };
  }, { a: read(files.a1), b: read(files.b1), na: read(files.a2), nb: read(files.b2), thr: threshold });
  fs.writeFileSync(outFile, Buffer.from(res.png, 'base64'));
  delete res.png;
  res.diffPercent = Number(((res.diffPixels / res.totalPixels) * 100).toFixed(4));
  return res;
}

// ---------- images for bug tickets ----------

// Crops the region that differs (diffBox plus a margin) out of both screenshots and the diff,
// outlines it in red, and writes one crop per environment plus one side-by-side image (A | B | diff).
// Very tall regions (e.g. everything shifted by an element at the top) are cut at MAX_H from the
// first differing row, because that is where the cause is.
async function makeBugImages(diffPage, files, box, names, outFiles) {
  const read = (f) => fs.readFileSync(f).toString('base64');
  const res = await diffPage.evaluate(async ({ a, b, d, box, names }) => {
    const load = async (s) => {
      const img = new Image();
      img.src = `data:image/png;base64,${s}`;
      await img.decode();
      return img;
    };
    const [A, B, D] = await Promise.all([a, b, d].map(load));
    const W = Math.max(A.width, B.width);
    const H = Math.max(A.height, B.height);
    const PAD = 40;
    const MIN_W = 480;
    const MIN_H = 160;
    const MAX_H = 1200;
    // Grow [lo, hi) to at least min, centred, within [0, max).
    const grow = (lo, hi, min, max) => {
      if (hi - lo >= min) return [lo, hi];
      const extra = min - (hi - lo);
      let l = Math.max(0, lo - Math.floor(extra / 2));
      const h = Math.min(max, l + min);
      l = Math.max(0, h - min);
      return [l, h];
    };
    const [x0, x1] = grow(Math.max(0, box[0] - PAD), Math.min(W, box[2] + 1 + PAD), MIN_W, W);
    let [y0, y1] = grow(Math.max(0, box[1] - PAD), Math.min(H, box[3] + 1 + PAD), MIN_H, H);
    const truncated = y1 - y0 > MAX_H;
    if (truncated) y1 = y0 + MAX_H;
    const cw = x1 - x0;
    const ch = y1 - y0;
    const crop = (img, outline) => {
      const c = new OffscreenCanvas(cw, ch);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, -x0, -y0);
      if (outline) {
        ctx.strokeStyle = 'rgb(230,20,60)';
        ctx.lineWidth = 3;
        const bx = Math.max(2, box[0] - x0 - 6);
        const by = Math.max(2, box[1] - y0 - 6);
        const bw = Math.min(cw - 2, box[2] - x0 + 7) - bx;
        const bh = Math.min(ch - 2, box[3] - y0 + 7) - by;
        ctx.strokeRect(bx, by, bw, bh);
      }
      return c;
    };
    const cA = crop(A, true);
    const cB = crop(B, true);
    const cD = crop(D, false);
    const GAP = 16;
    const HEAD = 40;
    const side = new OffscreenCanvas(cw * 3 + GAP * 4, ch + HEAD + GAP);
    const s = side.getContext('2d');
    s.fillStyle = '#f6f8fa';
    s.fillRect(0, 0, side.width, side.height);
    s.fillStyle = '#1f2328';
    s.font = 'bold 18px sans-serif';
    [cA, cB, cD].forEach((c, i) => {
      const x = GAP + i * (cw + GAP);
      s.fillText(names[i], x, 27, cw);
      s.drawImage(c, x, HEAD);
      s.strokeStyle = '#d0d7de';
      s.lineWidth = 1;
      s.strokeRect(x - 0.5, HEAD - 0.5, cw + 1, ch + 1);
    });
    const toB64 = async (c) => {
      const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    return { crop: [x0, y0, x1, y1], truncated, a: await toB64(cA), b: await toB64(cB), side: await toB64(side) };
  }, { a: read(files.a), b: read(files.b), d: read(files.diff), box, names });
  fs.writeFileSync(outFiles.a, Buffer.from(res.a, 'base64'));
  fs.writeFileSync(outFiles.b, Buffer.from(res.b, 'base64'));
  fs.writeFileSync(outFiles.side, Buffer.from(res.side, 'base64'));
  return { crop: res.crop, truncated: res.truncated };
}

// ---------- report ----------

const LABELS = {
  nl: {
    generated: 'Gegenereerd op', settings: 'Instellingen', overview: 'Overzicht',
    checkpoint: 'Checkpoint', pixels: 'Pixels', dom: 'DOM', network: 'Netwerk', facts: 'Pagina', verdict: 'Resultaat',
    identical: 'Identiek', different: 'Verschilt', missing: 'Ontbreekt', errors: 'Flow mislukt',
    step: 'stap', diff: 'Verschil', noise: 'ruis', noiseNote: 'Rood = verschil, geel = onstabiel binnen dezelfde omgeving (ruis).',
    changes: 'wijzigingen', none: 'Geen verschillen.', request: 'Request', kind: 'Soort',
    only: 'Enkel', changed: 'Anders', size: 'Afmetingen', production: 'productie',
    approx: 'Documenten te verschillend voor een volledige diff: enkel de regels die aan één kant vaker voorkomen.',
    console: 'Console-fouten', truncated: 'regels niet getoond, zie', runs: 'runs per omgeving', key: 'Eigenschap',
    readOnly: 'alleen-lezen (enkel GET)', writes: 'versturen toegelaten',
    blocked: 'Geblokkeerd door alleen-lezen voor dit checkpoint: de flow deed hier mogelijk niet wat hij moest doen.',
  },
  en: {
    generated: 'Generated on', settings: 'Settings', overview: 'Overview',
    checkpoint: 'Checkpoint', pixels: 'Pixels', dom: 'DOM', network: 'Network', facts: 'Page', verdict: 'Result',
    identical: 'Identical', different: 'Different', missing: 'Missing', errors: 'Flow failed',
    step: 'step', diff: 'Diff', noise: 'noise', noiseNote: 'Red = difference, yellow = unstable within the same environment (noise).',
    changes: 'changes', none: 'No differences.', request: 'Request', kind: 'Kind',
    only: 'Only', changed: 'Changed', size: 'Size', production: 'production',
    approx: 'Documents too different for a full diff: only the lines that occur more often on one side.',
    console: 'Console errors', truncated: 'lines not shown, see', runs: 'runs per environment', key: 'Property',
    readOnly: 'read-only (GET only)', writes: 'writes allowed',
    blocked: 'Blocked by read-only before this checkpoint: the flow may not have done what it should.',
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rel = (outDir, f) => path.relative(outDir, f).split(path.sep).join('/');

function renderHtml(summary, domTexts, cfg) {
  const L = LABELS[cfg.lang];
  const [nA, nB] = summary.environments.map((e) => e.name);
  const kindLabel = { onlyA: `${L.only} ${nA}`, onlyB: `${L.only} ${nB}`, changed: L.changed };
  const badge = (v) => `<span class="badge ${v}">${esc(L[v])}</span>`;
  const settings = summary.settings;
  const rows = summary.checkpoints.map((c) => `<tr>
    <td><a href="#cp-${esc(c.name)}">${esc(c.name)}</a></td>
    <td>${c.pixels ? `${c.pixels.diffPercent}%` : '—'}</td>
    <td>${c.dom ? c.dom.changes : '—'}</td>
    <td>${c.network ? c.network.filter((r) => !r.noise).length : '—'}</td>
    <td>${c.facts ? c.facts.filter((f) => !f.same && !f.noise).length : '—'}</td>
    <td>${badge(c.verdict)}</td></tr>`).join('');

  const errors = summary.errors.length ? `<div class="box err"><h2>${L.errors}</h2><ul>${summary.errors.map((e) =>
    `<li><b>${esc(e.env)} (run ${e.run})</b>, ${L.step} ${e.step}: <code>${esc(e.action)}</code><br>${esc(e.message)}
     <br><a href="${esc(rel(cfg.outDir, e.screenshot))}">screenshot</a></li>`).join('')}</ul></div>` : '';

  const sections = summary.checkpoints.map((c) => {
    if (c.verdict === 'missing') {
      return `<section id="cp-${esc(c.name)}"><h2>${esc(c.name)} ${badge('missing')}</h2><p>${esc(c.missing)}</p></section>`;
    }
    const facts = `<table><tr><th>${L.key}</th><th>${esc(nA)}</th><th>${esc(nB)}</th></tr>${c.facts.map((f) =>
      `<tr class="${f.same ? '' : f.noise ? 'noise' : 'changed'}"><td>${esc(f.key)}</td><td>${esc(f.rawA ?? f.a)}</td><td>${esc(f.rawB ?? f.b)}</td></tr>`).join('')}</table>`;
    const img = (f, cap) => `<figure><a href="${esc(f)}" target="_blank"><img src="${esc(f)}" loading="lazy" alt="${esc(cap)}"></a><figcaption>${esc(cap)}</figcaption></figure>`;
    const px = c.pixels;
    const shots = `<p class="muted">${px.diffPixels} px (${px.diffPercent}%) ${L.diff.toLowerCase()}, ${px.noisePixels} px ${L.noise}. ${L.size}: ${esc(nA)} ${px.a.join('×')}, ${esc(nB)} ${px.b.join('×')}. ${L.noiseNote}</p>
      <div class="shots">${img(c.files.a, nA)}${img(c.files.b, nB)}${img(c.files.diff, L.diff)}</div>`;
    const domText = domTexts[c.name];
    const MAX = 1500;
    const domHtml = domText.length ? `${c.dom.approx ? `<p class="muted">${L.approx}</p>` : ''}<p class="muted">- ${esc(nA)} · + ${esc(nB)} · ~ ${L.noise}</p><pre class="diff">${domText.slice(0, MAX).map((l) => {
      const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('~') ? 'noise' : l[0] === '-' ? 'del' : l[0] === '+' ? 'add' : '';
      return `<span class="${cls}">${esc(l)}</span>`;
    }).join('\n')}</pre>${domText.length > MAX ? `<p class="muted">${domText.length - MAX} ${L.truncated} ${esc(rel(cfg.outDir, c.dom.file))}</p>` : ''}` : `<p class="muted">${L.none}</p>`;
    const net = c.network.length ? `<table><tr><th>${L.kind}</th><th>${L.request}</th><th>${esc(nA)}</th><th>${esc(nB)}</th></tr>${c.network.map((r) =>
      `<tr class="${r.noise ? 'noise' : 'changed'}"><td>${esc(kindLabel[r.kind])}${r.noise ? ` (${L.noise})` : ''}</td><td class="url">${esc(r.request)} <span class="muted">${esc(r.type)}</span></td><td>${esc(r.a)}</td><td>${esc(r.b)}</td></tr>`).join('')}</table>` : `<p class="muted">${L.none}</p>`;
    const list = (msgs) => `<ul>${msgs.map((m) => `<li><code>${esc(m)}</code></li>`).join('')}</ul>`;
    const cons = c.console.a.length || c.console.b.length
      ? `<h3>${L.console}</h3><div class="two"><div><b>${esc(nA)}</b>${list(c.console.a)}</div><div><b>${esc(nB)}</b>${list(c.console.b)}</div></div>` : '';
    const blockedList = [...c.blocked.a, ...c.blocked.b];
    const blocked = blockedList.length
      ? `<div class="box err"><b>${L.blocked}</b><ul>${[...new Set(blockedList)].map((r) => `<li><code>${esc(r)}</code></li>`).join('')}</ul></div>` : '';
    return `<section id="cp-${esc(c.name)}"><h2>${esc(c.name)} ${badge(c.verdict)}</h2>${blocked}
      <h3>${L.facts}</h3>${facts}
      <h3>${L.pixels}</h3>${shots}
      <h3>${L.dom} <span class="muted">(${c.dom.changes} ${L.changes}, ${c.dom.noiseChanges} ${L.noise})</span></h3>${domHtml}
      <h3>${L.network}</h3>${net}${cons}</section>`;
  }).join('');

  const envLine = summary.environments.map((e) =>
    `<b>${esc(e.name)}</b>${e.production ? ` (${L.production})` : ''} <a href="${esc(e.url)}">${esc(e.url)}</a>`).join(' · ');

  return `<!doctype html>
<html lang="${cfg.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(nA)} vs. ${esc(nB)}: ${esc(summary.name)}</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--card:#f6f8fa;--red:#cf222e;--redbg:#ffebe9;--green:#1a7f37;--greenbg:#dafbe1;--yellow:#9a6700;--yellowbg:#fff8c5;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22;--red:#ff7b72;--redbg:#3c1618;--green:#3fb950;--greenbg:#12261e;--yellow:#d29922;--yellowbg:#2e2a16;--accent:#4493f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1400px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:15px;margin:20px 0 8px}
a{color:var(--accent)}.muted{color:var(--muted)}code{font-family:ui-monospace,Consolas,monospace;font-size:12px}
table{border-collapse:collapse;width:100%;margin:4px 0}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top;word-break:break-word}th{background:var(--card)}
tr.changed td{background:var(--redbg)}tr.noise td{color:var(--muted)}td.url{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.badge{display:inline-block;padding:1px 8px;border-radius:12px;font-size:12px;font-weight:600;vertical-align:middle}
.badge.identical{background:var(--greenbg);color:var(--green)}.badge.different{background:var(--redbg);color:var(--red)}.badge.missing{background:var(--yellowbg);color:var(--yellow)}
.box{border:1px solid var(--line);border-radius:6px;padding:8px 16px;margin:16px 0}.box.err{border-color:var(--red)}.box h2{border:0;margin:8px 0;padding:0}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}figure img{width:100%;border:1px solid var(--line);display:block}figcaption{color:var(--muted);font-size:12px;text-align:center}
pre.diff{background:var(--card);border:1px solid var(--line);padding:8px;overflow-x:auto;font-size:12px;line-height:1.4}
pre.diff .del{color:var(--red)}pre.diff .add{color:var(--green)}pre.diff .noise{color:var(--muted);font-style:italic}pre.diff .hunk{color:var(--accent)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:760px){.shots,.two{grid-template-columns:1fr}}
</style></head><body><main>
<h1>${esc(nA)} vs. ${esc(nB)}: ${esc(summary.name)}</h1>
<p>${envLine}</p>
<p class="muted">${L.generated} ${esc(summary.generatedAt)} · ${L.settings}: ${summary.allowWrites ? L.writes : L.readOnly}, ${esc(settings.browser)}, ${settings.viewport.width}×${settings.viewport.height}, ${esc(settings.locale)}, ${esc(settings.timezoneId)}, clock ${esc(settings.clock ?? 'real')}, ${settings.runs} ${L.runs}, pixelThreshold ${settings.pixelThreshold}</p>
${errors}
<h2>${L.overview}</h2>
<table><tr><th>${L.checkpoint}</th><th>${L.pixels}</th><th>${L.dom}</th><th>${L.network}</th><th>${L.facts}</th><th>${L.verdict}</th></tr>${rows}</table>
${sections}
</main></body></html>`;
}

// ---------- main ----------

async function main() {
  if (!process.argv[2]) fail('Usage: node twin-diff.js <config.json>');
  const cfg = loadConfig(process.argv[2]);
  const [envA, envB] = cfg.envs;
  fs.mkdirSync(cfg.outDir, { recursive: true });
  console.log(cfg.allowWrites ? 'Mode: writes allowed (no production environment)' : 'Mode: read-only (only GET, HEAD and OPTIONS)');

  const browser = await playwright[cfg.browser].launch();
  const results = [[], []];
  try {
    for (let r = 0; r < cfg.runs; r++) {
      for (const env of cfg.envs) {
        console.log(`run ${r + 1}/${cfg.runs}: ${env.name} (${env.base}) uid=${uidFor(env, r)}`);
        results[env.index].push(await runFlow(browser, cfg, env, r));
      }
    }

    const diffPage = await browser.newPage();
    const checkpoints = [];
    const domTexts = {};
    for (const step of cfg.steps.filter((s) => 'checkpoint' in s)) {
      const name = step.checkpoint;
      const [a1, a2] = results[0].map((x) => x.checkpoints[name]);
      const [b1, b2] = results[1].map((x) => x.checkpoints[name]);
      if (!a1 || !b1) {
        const missing = [!a1 && envA.name, !b1 && envB.name].filter(Boolean).join(' + ');
        checkpoints.push({ name, verdict: 'missing', missing: `Not reached on ${missing} (run 1).` });
        continue;
      }
      const dir = path.join(cfg.outDir, 'shots', name);
      const diffFile = path.join(dir, 'diff.png');
      const pixels = await comparePixels(diffPage, { a1: a1.shot, b1: b1.shot, a2: a2?.shot, b2: b2?.shot }, cfg.pixelThreshold, diffFile);
      // Cropped images of the visible difference, ready to attach to a bug ticket.
      let bug = null;
      if (pixels.diffBox) {
        const out = {
          a: path.join(dir, `bug-${envA.slug}.png`),
          b: path.join(dir, `bug-${envB.slug}.png`),
          side: path.join(dir, 'bug-side-by-side.png'),
        };
        const L = LABELS[cfg.lang];
        const made = await makeBugImages(diffPage, { a: a1.shot, b: b1.shot, diff: diffFile }, pixels.diffBox, [envA.name, envB.name, L.diff], out);
        bug = { a: rel(cfg.outDir, out.a), b: rel(cfg.outDir, out.b), side: rel(cfg.outDir, out.side), ...made };
      }
      const dom = compareDom(a1.dom, b1.dom, a2?.dom, b2?.dom, [envA.name, envB.name]);
      const domFile = path.join(cfg.outDir, `dom-${name}.diff`);
      fs.writeFileSync(domFile, `${dom.text.join('\n')}\n`);
      domTexts[name] = dom.text;
      const network = compareNetwork(a1.network, b1.network, a2?.network, b2?.network, cfg.ignoreNetwork);
      const facts = compareFacts(a1, b1, a2, b2);
      const different = pixels.diffPixels > 0 || dom.changes > 0 || network.some((n) => !n.noise) || facts.some((f) => !f.same && !f.noise);
      checkpoints.push({
        name,
        verdict: different ? 'different' : 'identical',
        files: { a: rel(cfg.outDir, a1.shot), b: rel(cfg.outDir, b1.shot), diff: rel(cfg.outDir, diffFile), bug },
        pixels,
        dom: { changes: dom.changes, noiseChanges: dom.noiseChanges, approx: dom.approx, file: domFile },
        network,
        facts,
        console: { a: a1.console, b: b1.console },
        // Requests the read-only guard blocked before this checkpoint: the flow may not have done what it should.
        blocked: {
          a: a1.network.filter((e) => e.status === 'blocked').map((e) => `${e.method} ${e.url}`),
          b: b1.network.filter((e) => e.status === 'blocked').map((e) => `${e.method} ${e.url}`),
        },
      });
    }

    const summary = {
      name: cfg.name,
      note: '"a" is environments[0], "b" is environments[1]. In the DOM diff "-" is a and "+" is b.',
      environments: cfg.envs.map((e) => ({ name: e.name, url: e.base, production: e.production, uids: results[e.index].map((r) => r.uid) })),
      allowWrites: cfg.allowWrites,
      generatedAt: new Date().toISOString(),
      settings: {
        browser: cfg.browser, viewport: cfg.viewport, locale: cfg.locale, timezoneId: cfg.timezoneId,
        clock: cfg.clock ? cfg.clock.toISOString() : null, runs: cfg.runs, pixelThreshold: cfg.pixelThreshold,
        fullPage: cfg.fullPage, mask: cfg.mask, ignoreNetwork: cfg.ignoreNetwork, allowNonGet: cfg.allowNonGet,
      },
      errors: cfg.envs.flatMap((env) => results[env.index].filter((r) => r.error).map((r) => ({ env: env.name, run: r.run + 1, ...r.error }))),
      checkpoints,
    };
    fs.writeFileSync(path.join(cfg.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(cfg.outDir, 'index.html'), renderHtml(summary, domTexts, cfg));

    for (const c of checkpoints) {
      if (c.verdict === 'missing') console.log(`${c.name}: MISSING (${c.missing})`);
      else {
        console.log(`${c.name}: ${c.verdict.toUpperCase()} | pixels ${c.pixels.diffPercent}% | dom ${c.dom.changes} (+${c.dom.noiseChanges} noise) | network ${c.network.filter((n) => !n.noise).length} (+${c.network.filter((n) => n.noise).length} noise) | facts ${c.facts.filter((f) => !f.same && !f.noise).length}`);
        if (c.files.bug) console.log(`  bug images: ${path.join(cfg.outDir, c.files.bug.side)}${c.files.bug.truncated ? ' (cut off: difference continues below)' : ''}`);
        for (const [i, list] of [c.blocked.a, c.blocked.b].entries()) {
          if (list.length) console.log(`  WARNING: ${list.length} request(s) blocked on ${cfg.envs[i].name} before "${c.name}": ${list.slice(0, 3).join(', ')}`);
        }
      }
    }
    for (const e of summary.errors) console.log(`ERROR ${e.env} run ${e.run}, step ${e.step} (${e.action}): ${e.message}`);
    console.log(`Report: ${path.join(cfg.outDir, 'index.html')}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

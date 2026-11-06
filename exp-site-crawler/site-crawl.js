#!/usr/bin/env node
// Crawls a site (same origin, breadth first) and records per page: console errors, pages and
// resources with status >= 400 or a failed request, broken images, mixed content, slow requests
// and slow pages, plus which page links to every broken URL ("found on"). External links and
// linked files are checked with HEAD (GET as fallback).
//
// Usage: node site-crawl.js <config.json>
// Writes <outDir>/summary.json and shots/*.png (only for what is visible: broken images, error pages).
// No HTML report: the images are meant to be attached to bug tickets.
//
// Strictly read-only: only GET, HEAD and OPTIONS requests are let through, no forms are submitted,
// links that can change something with a GET (logout, delete, add to cart, ...) are skipped,
// robots.txt is respected and there is a pause between pages. See SKILL.md.
'use strict';

const fs = require('fs');
const path = require('path');
const playwright = require('@playwright/test');

try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
} catch {
  // dotenv is optional: only needed for httpCredentialsEnv
}

// QUERY is the safe, idempotent HTTP method for read requests with a body (IETF httpbis draft):
// some apps fetch their data with it, and blocking it breaks the page.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'QUERY']);
const BLOCKED_BY_US = /ERR_BLOCKED_BY_CLIENT|blockedbyclient/i;
// Bot checks (Cloudflare) post on every page; blocking them does not break the page.
const BOT_CHECK = /\/cdn-cgi\/challenge-platform\//;
const ABORTED = /ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i;
// One rule for "broken", used per page and in the findings: a status >= 400, or a failure that is
// not our own block and not a plain abort without a response.
const isBroken = (q) => (q.status ?? 0) >= 400
  || Boolean(q.failure && !BLOCKED_BY_US.test(q.failure) && !(ABORTED.test(q.failure) && q.status === null));
const FILE_EXT = /\.(pdf|zip|rar|7z|docx?|xlsx?|pptx?|odt|ods|csv|txt|jpe?g|png|gif|svg|webp|avif|ico|mp4|webm|mov|mp3|wav|ics|xml|json|rss|exe|dmg|apk)$/i;
// Links that can change something with a plain GET. Matched case-insensitively against the full URL.
const DEFAULT_EXCLUDE = [
  'logout', 'log-out', 'signout', 'sign-out', 'uitloggen', 'afmelden', 'deconnexion', 'déconnexion',
  'delete', 'remove', 'verwijder', 'supprimer', 'unsubscribe', 'uitschrijven', 'desinscription',
  'add-to-cart', 'addtocart', 'add_to_cart', '/cart/add', 'action=', 'token=', 'nonce=', '/wp-admin', '/admin',
];
const SLOW_IGNORE_TYPES = new Set(['websocket', 'eventsource', 'media']);
const MAX_LIST = 100;

// ---------- config ----------

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'root';

function loadConfig(file) {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`Cannot read config ${file}: ${e.message}`);
  }
  const errors = [];
  if (typeof c.production !== 'boolean') errors.push('"production" must be true or false (when in doubt: true)');
  const production = c.production !== false;

  const startUrls = [];
  if (!Array.isArray(c.startUrls) || !c.startUrls.length || c.startUrls.length > 5) {
    errors.push('"startUrls" must be an array of 1 to 5 http(s) URLs');
  } else {
    for (const u of c.startUrls) {
      try {
        const url = new URL(u);
        if (!/^https?:$/.test(url.protocol)) throw new Error();
        url.hash = '';
        startUrls.push(url.href);
      } catch {
        errors.push(`startUrls: "${u}" is not an http(s) URL`);
      }
    }
  }
  const origins = new Set(startUrls.map((u) => new URL(u).origin));
  for (const o of c.includeOrigins ?? []) {
    try {
      origins.add(new URL(o).origin);
    } catch {
      errors.push(`includeOrigins: "${o}" is not a URL`);
    }
  }

  const maxPages = c.maxPages ?? 50;
  const maxPagesLimit = production ? 100 : 300;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > maxPagesLimit) {
    errors.push(`"maxPages" must be 1 to ${maxPagesLimit}${production ? ' on production' : ''}`);
  }
  const maxDepth = c.maxDepth ?? 3;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) errors.push('"maxDepth" must be 0 to 10');
  const minDelay = production ? 1000 : 200;
  const delayMs = Math.max(c.delayMs ?? (production ? 1000 : 500), minDelay);

  if (!c.outDir) errors.push('"outDir" is required');
  else if (fs.existsSync(c.outDir)) errors.push(`outDir ${c.outDir} already exists`);
  if (!['chromium', 'firefox', 'webkit'].includes(c.browser ?? 'chromium')) errors.push('"browser" must be chromium, firefox or webkit');

  let creds;
  if (c.httpCredentialsEnv) {
    const [user, pass] = c.httpCredentialsEnv;
    if (!process.env[user] || !process.env[pass]) errors.push(`${user} or ${pass} is not set in .env`);
    else creds = { username: process.env[user], password: process.env[pass] };
  }
  if (errors.length) fail(`Invalid config:\n- ${errors.join('\n- ')}`);

  return {
    name: c.name || 'crawl',
    outDir: c.outDir,
    production,
    startUrls,
    origins,
    maxPages,
    maxDepth,
    delayMs,
    exclude: [...(c.useDefaultExclude === false ? [] : DEFAULT_EXCLUDE), ...(c.exclude ?? [])].map((s) => s.toLowerCase()),
    ignoreQuery: c.ignoreQuery === true,
    respectRobots: c.respectRobots !== false,
    checkExternal: c.checkExternal !== false,
    maxExternal: Math.min(c.maxExternal ?? 100, 300),
    slowRequestMs: c.slowRequestMs ?? 2000,
    slowPageMs: c.slowPageMs ?? 5000,
    ignoreConsole: c.ignoreConsole ?? [],
    ignoreRequests: c.ignoreRequests ?? [],
    viewport: c.viewport ?? { width: 1280, height: 720 },
    browser: c.browser ?? 'chromium',
    locale: c.locale ?? 'nl-BE',
    timeout: c.timeout ?? 30000,
    creds,
  };
}

// ---------- urls ----------

function normalize(href, base, cfg) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    // Only internal pages are deduplicated without their query: external links are checked as they are.
    if (cfg.ignoreQuery && cfg.origins.has(u.origin)) u.search = '';
    return u.href;
  } catch {
    return null;
  }
}

const isExcluded = (url, cfg) => {
  const low = url.toLowerCase();
  return cfg.exclude.find((p) => low.includes(p)) ?? null;
};

async function loadRobots(request, origin) {
  try {
    const res = await request.get(`${origin}/robots.txt`, { timeout: 10000 });
    if (!res.ok()) return [];
    const rules = [];
    let applies = false;
    let lastWasAgent = false;
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const m = raw.replace(/#.*/, '').trim().match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'user-agent') {
        applies = (lastWasAgent && applies) || val === '*';
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (key === 'disallow' && applies && val) {
        // "*" is a wildcard and a trailing "$" anchors the end, as in robots.txt.
        const re = val.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        rules.push(new RegExp(`^${re}`));
      }
    }
    return rules;
  } catch {
    return [];
  }
}

const robotsBlocks = (url, robots) => {
  const u = new URL(url);
  const rules = robots.get(u.origin) ?? [];
  return rules.some((r) => r.test(u.pathname + u.search));
};

// ---------- in-page scan ----------

// Runs in the page: all links, broken images and resources loaded over http on an https page.
function scanPage() {
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter(Boolean);
  const broken = [];
  document.querySelectorAll('img').forEach((img, i) => {
    const src = img.currentSrc || img.src;
    if (!src || !img.complete || img.naturalWidth > 0) return;
    img.setAttribute('data-crawl-broken', String(i));
    broken.push({ id: String(i), src, alt: img.getAttribute('alt') });
  });
  const mixed = [];
  if (location.protocol === 'https:') {
    const check = (el, attr) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      const urls = attr === 'srcset' ? v.split(',').map((s) => s.trim().split(/\s+/)[0]) : [v];
      for (const u of urls) if (/^http:\/\//i.test(u)) mixed.push({ tag: el.tagName.toLowerCase(), attr, url: u });
    };
    document.querySelectorAll('img, script, iframe, video, audio, source, embed, track').forEach((el) => {
      check(el, 'src');
      check(el, 'srcset');
    });
    document.querySelectorAll('link[rel~="stylesheet"], link[rel~="icon"], link[rel~="preload"], link[rel~="manifest"]').forEach((el) => check(el, 'href'));
    document.querySelectorAll('object[data]').forEach((el) => check(el, 'data'));
    document.querySelectorAll('form[action]').forEach((el) => check(el, 'action'));
  }
  return { title: document.title, links, broken, mixed };
}

// ---------- one page ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function visit(context, cfg, url, index) {
  const page = await context.newPage();
  const requests = [];
  const pending = [];
  const consoleMsgs = [];
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (t === 'error' || (t === 'warning' && /mixed content/i.test(text))) consoleMsgs.push({ type: t, text: text.slice(0, 400) });
  });
  page.on('pageerror', (err) => consoleMsgs.push({ type: 'pageerror', text: String(err.message).slice(0, 400) }));
  page.on('requestfinished', (req) => {
    pending.push(req.response().then((res) => {
      const t = req.timing();
      requests.push({
        url: req.url(), method: req.method(), type: req.resourceType(), status: res ? res.status() : null,
        duration: t && t.responseEnd >= 0 ? Math.round(t.responseEnd) : null,
      });
    }).catch(() => {}));
  });
  // A request can fail after its response arrived (e.g. a 404 script with MIME text/html that the
  // browser refuses and aborts): keep that status, so it counts as a 404 and not as an abort.
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? 'failed';
    pending.push(req.response().catch(() => null).then((res) => {
      requests.push({ url: req.url(), method: req.method(), type: req.resourceType(), status: res ? res.status() : null, failure });
    }));
  });

  const out = { url, finalUrl: null, status: null, loadMs: null, title: null, error: null, links: [], brokenImages: [], mixedDom: [], requests, console: consoleMsgs, shot: null };
  try {
    const t0 = Date.now();
    const res = await page.goto(url, { waitUntil: 'load' });
    out.loadMs = Date.now() - t0;
    out.status = res ? res.status() : null;
    out.finalUrl = page.url();
    out.contentType = res ? (res.headers()['content-type'] ?? '') : '';
    if (out.contentType && !/html/i.test(out.contentType)) {
      await page.close();
      return out;
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 25; y += step, i++) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const scan = await page.evaluate(scanPage);
    out.title = scan.title;
    out.links = scan.links;
    out.mixedDom = scan.mixed;
    const slug = `${String(index).padStart(3, '0')}-${slugify(new URL(url).pathname + new URL(url).search)}`;
    if ((out.status ?? 0) >= 400) {
      out.shot = path.join(cfg.outDir, 'shots', `${slug}_status-${out.status}.png`);
      fs.mkdirSync(path.dirname(out.shot), { recursive: true });
      await page.screenshot({ path: out.shot });
    }
    // A crop around every broken image (40 px margin), with a red outline.
    if (scan.broken.length) await page.addStyleTag({ content: '[data-crawl-broken]{outline:3px solid #e6143c !important;outline-offset:2px !important}' });
    for (const b of scan.broken.slice(0, 10)) {
      const loc = page.locator(`[data-crawl-broken="${b.id}"]`);
      let shot = null;
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
        const box = await loc.boundingBox();
        if (box) {
          const vp = page.viewportSize();
          const x = Math.max(0, box.x - 40);
          const y = Math.max(0, box.y - 40);
          const w = Math.min(Math.max(box.width + 80, 240), vp.width - x);
          const h = Math.min(Math.max(box.height + 80, 120), vp.height - y);
          if (w > 0 && h > 0) {
            shot = path.join(cfg.outDir, 'shots', `${slug}_broken-image-${b.id}.png`);
            fs.mkdirSync(path.dirname(shot), { recursive: true });
            await page.screenshot({ path: shot, clip: { x, y, width: w, height: h } });
          }
        }
      } catch {
        shot = null;
      }
      out.brokenImages.push({ src: b.src, alt: b.alt, shot });
    }
  } catch (e) {
    out.error = String(e.message).split('\n')[0];
  }
  await Promise.all(pending);
  await page.close();
  return out;
}

// ---------- link checks (HEAD, GET as fallback) ----------

async function checkUrl(request, url, cfg) {
  const opts = { timeout: 15000, maxRedirects: 5, failOnStatusCode: false };
  try {
    let res = await request.head(url, opts);
    // Many servers answer HEAD differently than a normal visit (Facebook 400, single-page apps 404):
    // confirm every status >= 400 with a GET.
    if (res.status() >= 400) res = await request.get(url, opts);
    return { status: res.status() };
  } catch (e) {
    return { status: null, failure: String(e.message).split('\n')[0].slice(0, 200) };
  } finally {
    await sleep(Math.min(cfg.delayMs, 500));
  }
}

// ---------- aggregation ----------

const rel = (cfg, f) => (f ? path.relative(cfg.outDir, f).split(path.sep).join('/') : null);
const matchesAny = (s, patterns) => patterns.some((p) => s.includes(p));
const addTo = (map, key, init, page) => {
  if (!map.has(key)) map.set(key, { ...init, pages: new Set() });
  if (page) map.get(key).pages.add(page);
  return map.get(key);
};
// Sets other than "pages" become their size (e.g. onPagesWithBlockedRequests).
const listOf = (map, sortKey) => [...map.values()]
  .map((v) => ({
    ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x instanceof Set ? x.size : x])),
    pageCount: v.pages.size, pages: [...v.pages].slice(0, 20),
  }))
  .sort(sortKey ?? ((a, b) => b.pageCount - a.pageCount))
  .slice(0, MAX_LIST);
// Console messages often differ only in a number or a hash: group on the message without those.
const consoleKey = (t) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 200);

// ---------- main ----------

async function main() {
  if (!process.argv[2]) fail('Usage: node site-crawl.js <config.json>');
  const cfg = loadConfig(process.argv[2]);
  fs.mkdirSync(cfg.outDir, { recursive: true });
  console.log(`Read-only crawl (only ${[...SAFE_METHODS].join(', ')}). ${cfg.production ? 'PRODUCTION: ' : ''}max ${cfg.maxPages} pages, depth ${cfg.maxDepth}, ${cfg.delayMs} ms between pages.`);

  const browser = await playwright[cfg.browser].launch();
  const context = await browser.newContext({
    viewport: cfg.viewport, deviceScaleFactor: 1, locale: cfg.locale, timezoneId: 'Europe/Brussels',
    colorScheme: 'light', serviceWorkers: 'block', httpCredentials: cfg.creds,
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(cfg.timeout);
  const blocked = [];
  await context.route('**/*', (route) => {
    const req = route.request();
    if (SAFE_METHODS.has(req.method())) return route.fallback();
    blocked.push(`${req.method()} ${req.url()}`);
    return route.abort('blockedbyclient');
  });
  const request = context.request;

  const robots = new Map();
  if (cfg.respectRobots) for (const o of cfg.origins) robots.set(o, await loadRobots(request, o));

  const queue = cfg.startUrls.map((url) => ({ url, depth: 0 }));
  const queued = new Set(cfg.startUrls);
  const linkedFrom = new Map(); // url -> Set of pages that link to it
  const externals = new Set();
  const files = new Set();
  const skipped = { robots: new Set(), excluded: new Map(), depth: 0 };
  const pages = [];
  let stopReason = null;
  let consecutive5xx = 0;

  try {
    while (queue.length && pages.length < cfg.maxPages) {
      const { url, depth } = queue.shift();
      const index = pages.length + 1;
      const r = await visit(context, cfg, url, index);
      r.depth = depth;
      pages.push(r);
      const counts = {
        console: r.console.filter((m) => m.type !== 'warning' && !BLOCKED_BY_US.test(m.text)).length,
        failed: r.requests.filter(isBroken).length,
        brokenImages: r.brokenImages.length,
        slow: r.requests.filter((q) => (q.duration ?? 0) > cfg.slowRequestMs).length,
      };
      console.log(`[${index}/${cfg.maxPages}] ${r.status ?? 'ERR'} ${url} | ${r.loadMs ?? '-'} ms | console ${counts.console} | failed ${counts.failed} | broken img ${counts.brokenImages} | slow ${counts.slow}${r.error ? ` | ERROR ${r.error}` : ''}`);

      if (r.status === 429) {
        stopReason = `429 Too Many Requests on ${url}: crawl stopped`;
        break;
      }
      consecutive5xx = (r.status ?? 0) >= 500 ? consecutive5xx + 1 : 0;
      if (consecutive5xx >= 3) {
        stopReason = `3 pages in a row with status 5xx (last: ${url}): crawl stopped`;
        break;
      }

      for (const href of r.links) {
        const link = normalize(href, r.finalUrl ?? url, cfg);
        if (!link) continue;
        if (!linkedFrom.has(link)) linkedFrom.set(link, new Set());
        linkedFrom.get(link).add(url);
        const internal = cfg.origins.has(new URL(link).origin);
        if (!internal) {
          externals.add(link);
          continue;
        }
        if (queued.has(link)) continue;
        const ex = isExcluded(link, cfg);
        if (ex) {
          if (!skipped.excluded.has(link)) skipped.excluded.set(link, ex);
          continue;
        }
        if (cfg.respectRobots && robotsBlocks(link, robots)) {
          skipped.robots.add(link);
          continue;
        }
        if (FILE_EXT.test(new URL(link).pathname)) {
          files.add(link);
          queued.add(link);
          continue;
        }
        if (depth + 1 > cfg.maxDepth) {
          skipped.depth++;
          continue;
        }
        queued.add(link);
        queue.push({ url: link, depth: depth + 1 });
      }
      if (queue.length && pages.length < cfg.maxPages) await sleep(cfg.delayMs);
    }

    // Linked files on the site and external links: HEAD (GET as fallback), no browser.
    const linkChecks = [];
    for (const f of files) linkChecks.push({ url: f, kind: 'file', ...(await checkUrl(request, f, cfg)) });
    if (cfg.checkExternal) {
      for (const e of [...externals].slice(0, cfg.maxExternal)) linkChecks.push({ url: e, kind: 'external', ...(await checkUrl(request, e, cfg)) });
    }

    // ---------- findings ----------
    const pageUrls = new Set(pages.map((p) => p.url));
    const found = (u) => [...(linkedFrom.get(u) ?? [])].slice(0, 20);

    const brokenPages = pages.filter((p) => (p.status ?? 0) >= 400 || p.error).map((p) => ({
      url: p.url, status: p.status, error: p.error, foundOn: found(p.url), foundOnCount: linkedFrom.get(p.url)?.size ?? 0, shot: rel(cfg, p.shot),
    }));
    const brokenLinks = linkChecks.filter((l) => l.status === null || l.status >= 400).map((l) => ({
      ...l, uncertain: l.status === null || [401, 403, 429, 999].includes(l.status), foundOn: found(l.url), foundOnCount: linkedFrom.get(l.url)?.size ?? 0,
    }));

    const resources = new Map();
    const consoleErrors = new Map();
    const mixed = new Map();
    const slow = new Map();
    const brokenImages = new Map();
    for (const p of pages) {
      const https = (p.finalUrl ?? p.url).startsWith('https:');
      // Console errors on a page where the read-only guard blocked something may be caused by that block.
      const pageBlocked = p.requests.some((q) => q.failure && BLOCKED_BY_US.test(q.failure) && !BOT_CHECK.test(q.url) && !matchesAny(q.url, cfg.ignoreRequests));
      for (const q of p.requests) {
        if (matchesAny(q.url, cfg.ignoreRequests) || q.url.startsWith('data:')) continue;
        if (q.type === 'document' && pageUrls.has(q.url)) continue; // reported as broken page
        if (isBroken(q)) {
          addTo(resources, q.url, { url: q.url, type: q.type, status: q.status, failure: q.failure ?? null }, p.url);
        }
        if (https && q.url.startsWith('http:')) addTo(mixed, q.url, { url: q.url, source: `request (${q.type})` }, p.url);
        if ((q.duration ?? 0) > cfg.slowRequestMs && !SLOW_IGNORE_TYPES.has(q.type)) {
          const e = addTo(slow, q.url, { url: q.url, type: q.type, maxMs: 0 }, p.url);
          e.maxMs = Math.max(e.maxMs, q.duration);
        }
      }
      for (const m of p.console) {
        if (matchesAny(m.text, cfg.ignoreConsole) || BLOCKED_BY_US.test(m.text)) continue;
        if (/mixed content/i.test(m.text)) {
          const u = (m.text.match(/insecure [\w ]*'(http:[^']+)'/i) ?? [])[1] ?? m.text.slice(0, 120);
          addTo(mixed, u, { url: u, source: 'console' }, p.url);
          continue;
        }
        if (m.type === 'warning') continue;
        const e = addTo(consoleErrors, consoleKey(m.text), { message: m.text, type: m.type, onPagesWithBlockedRequests: new Set() }, p.url);
        if (pageBlocked) e.onPagesWithBlockedRequests.add(p.url);
      }
      for (const d of p.mixedDom) addTo(mixed, d.url, { url: d.url, source: `<${d.tag} ${d.attr}>` }, p.url);
      for (const b of p.brokenImages) {
        const e = addTo(brokenImages, b.src, { src: b.src, alt: b.alt, shot: null }, p.url);
        if (!e.shot && b.shot) e.shot = rel(cfg, b.shot);
      }
    }
    const slowPages = pages.filter((p) => (p.loadMs ?? 0) > cfg.slowPageMs)
      .map((p) => ({ url: p.url, loadMs: p.loadMs })).sort((a, b) => b.loadMs - a.loadMs);
    const redirects = pages.filter((p) => p.finalUrl && p.finalUrl !== p.url)
      .map((p) => ({ from: p.url, to: p.finalUrl, foundOn: found(p.url).slice(0, 5) })).slice(0, MAX_LIST);

    const findings = {
      brokenPages,
      brokenLinks,
      brokenResources: listOf(resources),
      brokenImages: listOf(brokenImages),
      consoleErrors: listOf(consoleErrors),
      mixedContent: listOf(mixed),
      slowRequests: listOf(slow, (a, b) => b.maxMs - a.maxMs),
      slowPages,
      redirects,
    };
    const summary = {
      name: cfg.name,
      generatedAt: new Date().toISOString(),
      stopReason,
      settings: {
        production: cfg.production, startUrls: cfg.startUrls, origins: [...cfg.origins], maxPages: cfg.maxPages, maxDepth: cfg.maxDepth,
        delayMs: cfg.delayMs, respectRobots: cfg.respectRobots, checkExternal: cfg.checkExternal, maxExternal: cfg.maxExternal,
        slowRequestMs: cfg.slowRequestMs, slowPageMs: cfg.slowPageMs, exclude: cfg.exclude, ignoreConsole: cfg.ignoreConsole,
        ignoreRequests: cfg.ignoreRequests, browser: cfg.browser, viewport: cfg.viewport,
      },
      counts: {
        pagesCrawled: pages.length,
        notCrawled: queue.length,
        filesChecked: files.size,
        externalChecked: cfg.checkExternal ? Math.min(externals.size, cfg.maxExternal) : 0,
        externalFound: externals.size,
        skippedRobots: skipped.robots.size,
        skippedExcluded: skipped.excluded.size,
        skippedDepth: skipped.depth,
        blockedNonGet: blocked.length,
        ...Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length])),
      },
      findings,
      skipped: {
        robots: [...skipped.robots].slice(0, 30),
        excluded: [...skipped.excluded].slice(0, 30).map(([url, pattern]) => ({ url, pattern })),
        notCrawled: queue.slice(0, 30).map((q) => q.url),
        blockedNonGet: blocked.slice(0, 30),
      },
      pages: pages.map((p) => ({
        url: p.url, finalUrl: p.finalUrl, status: p.status, depth: p.depth, loadMs: p.loadMs, title: p.title, error: p.error,
        consoleErrors: p.console.filter((m) => m.type !== 'warning' && !BLOCKED_BY_US.test(m.text)).length,
        failedRequests: p.requests.filter(isBroken).length,
        brokenImages: p.brokenImages.length,
      })),
    };
    fs.writeFileSync(path.join(cfg.outDir, 'summary.json'), JSON.stringify(summary, null, 2));

    console.log(`\nPages crawled: ${pages.length}${queue.length ? ` (${queue.length} more in the queue, maxPages reached)` : ''}`);
    for (const [k, v] of Object.entries(findings)) console.log(`  ${k}: ${v.length}`);
    console.log(`  skipped: robots ${skipped.robots.size}, excluded ${skipped.excluded.size}, depth ${skipped.depth}; blocked non-GET ${blocked.length}`);
    if (stopReason) console.log(`STOPPED: ${stopReason}`);
    console.log(`Summary: ${path.join(cfg.outDir, 'summary.json')}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => fail(e.stack || String(e)));

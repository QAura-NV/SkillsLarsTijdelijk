#!/usr/bin/env node
// Opens the same pages in several languages (e.g. NL, FR and EN) and puts them side by side:
// visible translation keys and placeholders, texts that are identical across languages (candidates
// for a missing translation), text that overflows or is cut off, encoding errors, html lang and
// hreflang, and date, number and currency formats compared with what Intl expects per locale.
//
// Usage: node i18n-inspect.js <config.json>
// Writes <outDir>/summary.json, texts/<page>.tsv and shots/<page>/<viewport>/*.png.
// No HTML report: the images are meant to be attached to bug tickets.
//
// Strictly read-only: only GET, HEAD and OPTIONS requests are let through. See SKILL.md.
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
const DEFAULT_LOCALES = { nl: 'nl-BE', fr: 'fr-BE', en: 'en-GB', de: 'de-BE' };
const DEFAULT_VIEWPORTS = [{ name: 'desktop', width: 1280, height: 720 }, { name: 'mobile', width: 360, height: 740 }];
const MAX_FINDING_IMAGES = 15;
const SIDE_MAX_H = 3000;
const MAX_LIST = 60;

// ---------- config ----------

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const isSlug = (s) => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);

function loadConfig(file) {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`Cannot read config ${file}: ${e.message}`);
  }
  const errors = [];

  const languages = [];
  if (!Array.isArray(c.languages) || c.languages.length < 2 || c.languages.length > 4) {
    errors.push('"languages" must be an array of 2 to 4 { "code", "url" }');
  } else {
    c.languages.forEach((l, i) => {
      const where = `languages[${i}]`;
      const code = String(l.code ?? '').toLowerCase();
      if (!/^[a-z]{2}$/.test(code)) errors.push(`${where}: "code" must be a two-letter language code (nl, fr, en, de)`);
      const locale = l.locale ?? DEFAULT_LOCALES[code];
      try {
        new Intl.Locale(locale);
      } catch {
        errors.push(`${where}: "locale" is missing or invalid (e.g. nl-BE, fr-BE, en-GB)`);
      }
      let base = null;
      try {
        const u = new URL(l.url);
        if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
        base = u.origin + u.pathname.replace(/\/$/, '');
      } catch {
        errors.push(`${where}: "url" must be an http(s) URL`);
      }
      const cookies = Array.isArray(l.cookies) ? l.cookies : [];
      if (cookies.some((ck) => typeof ck.name !== 'string' || typeof ck.value !== 'string')) {
        errors.push(`${where}: "cookies" must be [{ "name", "value" }]`);
      }
      languages.push({ code, locale, base, url: l.url, cookies });
    });
    const codes = languages.map((l) => l.code);
    if (new Set(codes).size !== codes.length) errors.push('every language needs a different "code"');
  }

  const pages = Array.isArray(c.pages) ? c.pages : [];
  if (!pages.length || pages.length > 10) errors.push('"pages" must be an array of 1 to 10 pages');
  const pageNames = new Set();
  pages.forEach((p, i) => {
    const where = `pages[${i}]`;
    if (!isSlug(p.name)) errors.push(`${where}: "name" must be kebab-case`);
    if (pageNames.has(p.name)) errors.push(`${where}: duplicate page name "${p.name}"`);
    pageNames.add(p.name);
    if (p.paths) {
      for (const l of languages) {
        const v = p.paths[l.code];
        if (typeof v !== 'string' || !v.startsWith('/')) errors.push(`${where}: "paths.${l.code}" must be a path starting with "/"`);
      }
    } else if (typeof p.path !== 'string' || !p.path.startsWith('/')) {
      errors.push(`${where}: give "path" (same for every language) or "paths" (one per language code)`);
    }
  });

  const viewports = c.viewports ?? DEFAULT_VIEWPORTS;
  if (!Array.isArray(viewports) || !viewports.length || viewports.length > 3) errors.push('"viewports" must be an array of 1 to 3 viewports');
  else {
    viewports.forEach((v, i) => {
      if (!isSlug(v.name) || !Number.isInteger(v.width) || !Number.isInteger(v.height)) {
        errors.push(`viewports[${i}]: needs a kebab-case "name" and integer "width" and "height"`);
      }
    });
  }

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
    name: c.name || 'i18n',
    outDir: c.outDir,
    languages,
    pages,
    viewports,
    browser: c.browser ?? 'chromium',
    timezoneId: c.timezoneId ?? 'Europe/Brussels',
    timeout: c.timeout ?? 30000,
    mask: c.mask ?? [],
    creds,
  };
}

const urlFor = (lang, page) => lang.base + (page.paths ? page.paths[lang.code] : page.path);

// ---------- expected formats (Intl, in Node) ----------

function expectedFormats(locale, timeZone) {
  const sample = new Date(Date.UTC(2026, 2, 31, 12, 30));
  const df = new Intl.DateTimeFormat(locale, { timeZone });
  const order = df.formatToParts(sample).map((p) => p.type).filter((t) => ['day', 'month', 'year'].includes(t));
  const date = df.format(sample);
  const np = new Intl.NumberFormat(locale).formatToParts(1234567.89);
  const cur = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  const cp = cur.formatToParts(1234.5);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(sample);
  return {
    sampleDate: '2026-03-31',
    date,
    dateLong: new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(sample),
    time,
    number: new Intl.NumberFormat(locale).format(1234567.89),
    currency: cur.format(1234.5),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(0.255),
    dateOrder: order.join('-'),
    dateSeparator: (date.match(/\D/) ?? [''])[0],
    decimal: np.find((p) => p.type === 'decimal')?.value ?? '.',
    group: np.find((p) => p.type === 'group')?.value ?? ',',
    currencyFirst: cp.findIndex((p) => p.type === 'currency') < cp.findIndex((p) => p.type === 'integer'),
    twelveHour: /am|pm/i.test(time),
  };
}

const MONTHS = {
  nl: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  de: ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
};
// Month names that exist in only one language: seeing one on a page in another language is a finding.
const UNIQUE_MONTHS = Object.fromEntries(Object.entries(MONTHS).map(([code, list]) => [
  code, list.filter((m) => Object.entries(MONTHS).every(([other, l]) => other === code || !l.includes(m))),
]));

function checkFormats(texts, lang, exp) {
  const findings = [];
  const samples = [];
  const seen = new Set();
  const add = (kind, match, text, note) => {
    const key = `${kind}|${match}`;
    if (seen.has(key) || findings.length >= MAX_LIST) return;
    seen.add(key);
    findings.push({ kind, match, text: text.slice(0, 160), note });
  };
  const sample = (kind, match) => {
    if (samples.length < 25 && !samples.some((s) => s.match === match)) samples.push({ kind, match });
  };
  const dayFirst = exp.dateOrder.startsWith('day');
  for (const { text } of texts) {
    for (const m of text.matchAll(/\b(\d{1,4})([/.-])(\d{1,2})\2(\d{2,4})\b/g)) {
      sample('date', m[0]);
      if (m[1].length === 4) {
        add('date-iso', m[0], text, `ISO-notation; ${lang.locale} expects ${exp.date}`);
        continue;
      }
      const a = Number(m[1]);
      const b = Number(m[3]);
      if (dayFirst && b > 12 && a <= 12) add('date-order', m[0], text, `month first; ${lang.locale} expects ${exp.dateOrder} (${exp.date})`);
      else if (!dayFirst && a > 12 && b <= 12) add('date-order', m[0], text, `day first; ${lang.locale} expects ${exp.dateOrder} (${exp.date})`);
      else if (m[2] !== exp.dateSeparator) add('date-separator', m[0], text, `separator "${m[2]}"; ${lang.locale} uses "${exp.dateSeparator}" (${exp.date})`);
    }
    for (const m of text.matchAll(/(?:€|EUR)\s?\d[\d.,   ]*\d|\d[\d.,   ]*\d?\s?(?:€|EUR)\b|\d\s?€/g)) {
      const s = m[0].trim();
      sample('currency', s);
      const first = /^(€|EUR)/.test(s);
      if (first !== exp.currencyFirst) add('currency-position', s, text, `${lang.locale} expects ${exp.currency}`);
      const dec = s.match(/([.,])(\d{1,2})\s?(?:€|EUR)?$/);
      if (dec && dec[1] !== exp.decimal) add('currency-decimal', s, text, `decimal separator "${dec[1]}"; ${lang.locale} expects ${exp.currency}`);
    }
    for (const m of text.matchAll(/\b\d{1,3}(?:([.,   ])\d{3})+([.,])\d+\b/g)) {
      sample('number', m[0]);
      if (m[2] !== exp.decimal) add('number-format', m[0], text, `${lang.locale} expects ${exp.number}`);
    }
    for (const m of text.matchAll(/\b\d{1,3}(?:[.,]\d+)?\s?%/g)) sample('percent', m[0]);
    if (!exp.twelveHour) {
      for (const m of text.matchAll(/\b\d{1,2}(?::\d{2})?\s?(?:AM|PM|am|pm|a\.m\.|p\.m\.)/g)) add('time-12h', m[0], text, `${lang.locale} uses 24 hours (${exp.time})`);
    }
    const lower = text.toLowerCase();
    for (const [code, months] of Object.entries(UNIQUE_MONTHS)) {
      if (code === lang.code) continue;
      for (const month of months) {
        if (new RegExp(`(^|[^\\p{L}])${month}([^\\p{L}]|$)`, 'u').test(lower)) add('month-foreign', month, text, `month name in "${code}" on a "${lang.code}" page`);
      }
    }
  }
  return { findings, samples };
}

// ---------- in-page scan ----------

// Runs in the page. Collects visible texts and attributes with a structural path, flags
// overflow and key-like texts, and marks flagged elements with data-i18n-flag for the screenshot.
function scanPage() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT']);
  const ATTRS = ['alt', 'title', 'placeholder', 'aria-label'];
  const PATTERNS = [
    // Translation keys start lowercase (label.submit, form.errors.required); "My.Belgium" is a brand.
    ['key', /^[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+$/,
      (t) => !/\.(com|be|nl|fr|eu|org|net|io|dev|html?|php|aspx?|js|css|png|jpe?g|svg|gif|webp|pdf|docx?|xlsx?)$/i.test(t) && !/^(www|e\.g|i\.e|bv|vb|cf|etc)\./i.test(t)],
    ['key', /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/],
    ['placeholder', /\{\{[^}]*\}\}|\$\{[^}]*\}|%\d?\$?[sd]\b|\{[a-zA-Z_][\w.]*\}|__[A-Za-z_]+__/],
    ['missing', /missing translation|translation missing|\[missing |\bTODO\b|\bFIXME\b|lorem ipsum/i],
    ['encoding', /Ã[\u0080-¿]|â€|Â[  ]|�|&(?:amp|nbsp|eacute|egrave|agrave|ccedil|quot|lt|gt|#\d{2,5});/],
  ];
  const vw = document.documentElement.clientWidth;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(`${e.tagName.toLowerCase()}:${i}`);
    }
    return parts.join('>');
  };
  const rectOf = (r) => [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)];
  const isVisible = (el) => {
    if (typeof el.checkVisibility === 'function'
      && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Visually hidden text for screen readers (sr-only / visually-hidden): a 1-2 px box that clips,
  // or a clip / clip-path that hides it. Never overflow, but still compared as text.
  const isScreenReaderOnly = (el) => {
    for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      if ((r.width <= 2 || r.height <= 2) && /hidden|clip/.test(`${cs.overflowX} ${cs.overflowY}`)) return true;
      if (cs.clip && cs.clip !== 'auto') return true;
      if (/inset\((?:50|100)%/.test(cs.clipPath)) return true;
    }
    return false;
  };
  const keyKind = (t) => {
    for (const [kind, re, extra] of PATTERNS) if (re.test(t) && (!extra || extra(t))) return kind;
    return null;
  };

  const texts = [];
  const attrs = [];
  const overflow = [];
  const keys = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (el) => (SKIP.has(el.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let count = 0;
  for (let el = walker.currentNode; el && count < 6000; el = walker.nextNode(), count++) {
    if (el === document.body || !isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const own = norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
    const r = el.getBoundingClientRect();
    const rect = rectOf(r);
    const srOnly = isScreenReaderOnly(el);
    let p = null;
    const pathLazy = () => (p ??= pathOf(el));
    const collect = (list, item) => {
      list.push(item);
      const kind = keyKind(item.text);
      if (kind) {
        keys.push({ ...item, kind });
        if (!item.srOnly && !el.hasAttribute('data-i18n-flag')) el.setAttribute('data-i18n-flag', 'key');
      }
    };
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && norm(v)) collect(attrs, { path: `${pathLazy()}@${a}`, tag, text: norm(v).slice(0, 300), rect });
    }
    if (tag === 'input' && /^(submit|button|reset)$/i.test(el.type) && el.value) {
      collect(attrs, { path: `${pathLazy()}@value`, tag, text: norm(el.value).slice(0, 300), rect });
    }
    if (!own) continue;
    collect(texts, { path: pathLazy(), tag, text: own.slice(0, 300), rect, ...(srOnly ? { srOnly: true } : {}) });
    if (srOnly) continue;

    const kinds = [];
    const cs = getComputedStyle(el);
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      kinds.push(cs.textOverflow === 'ellipsis' ? 'ellipsis' : /hidden|clip/.test(cs.overflowX) ? 'clipped' : 'spills');
    }
    if (el.clientHeight > 0 && /hidden|clip/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) kinds.push('clipped-vertical');
    for (let a = el.parentElement, i = 0; a && a !== document.body && i < 4; a = a.parentElement, i++) {
      const acs = getComputedStyle(a);
      if (/hidden|clip/.test(`${acs.overflowX} ${acs.overflowY}`)) {
        const ar = a.getBoundingClientRect();
        if (r.right > ar.right + 1 || r.bottom > ar.bottom + 1 || r.left < ar.left - 1) kinds.push('clipped-by-parent');
        break;
      }
    }
    if ((r.left < vw && r.right > vw + 1) || (r.left < -1 && r.right > 0)) kinds.push('offscreen');
    if (kinds.length) {
      overflow.push({ path: pathLazy(), tag, text: own.slice(0, 160), kinds, rect });
      el.setAttribute('data-i18n-flag', 'overflow');
    }
  }
  const meta = (sel, a) => document.querySelector(sel)?.getAttribute(a) ?? null;
  return {
    texts,
    attrs,
    overflow,
    keys,
    horizontalScroll: document.documentElement.scrollWidth > vw + 1,
    pageWidth: document.documentElement.scrollWidth,
    meta: {
      title: document.title,
      lang: document.documentElement.getAttribute('lang'),
      description: meta('meta[name="description"]', 'content'),
      ogTitle: meta('meta[property="og:title"]', 'content'),
      alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => `${l.getAttribute('hreflang')} ${l.getAttribute('href')}`),
    },
  };
}

const FLAG_CSS = `[data-i18n-flag="overflow"]{outline:3px solid #e6143c !important;outline-offset:2px !important}
[data-i18n-flag="key"]{outline:3px dashed #ff8c00 !important;outline-offset:2px !important}`;

// ---------- one page in one language ----------

async function newContext(browser, cfg, lang, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    locale: lang.locale,
    timezoneId: cfg.timezoneId,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    httpCredentials: cfg.creds,
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(cfg.timeout);
  if (lang.cookies.length) await context.addCookies(lang.cookies.map((c) => ({ name: c.name, value: c.value, url: lang.url })));
  // Read-only guard: block every request that could change data.
  await context.route('**/*', (route) => (SAFE_METHODS.has(route.request().method()) ? route.fallback() : route.abort('blockedbyclient')));
  return context;
}

async function inspectPage(context, cfg, lang, pageCfg, shotFile) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err.message).slice(0, 300)}`));
  const url = urlFor(lang, pageCfg);
  const out = { url, finalUrl: null, status: null, error: null, consoleErrors };
  fs.mkdirSync(path.dirname(shotFile), { recursive: true });
  try {
    const res = await page.goto(url, { waitUntil: 'load' });
    out.status = res ? res.status() : null;
    out.finalUrl = page.url();
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    // Scroll once through the page so lazy content renders, then back to the top.
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 25; y += step, i++) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    Object.assign(out, await page.evaluate(scanPage));
    await page.addStyleTag({ content: FLAG_CSS });
    await page.screenshot({
      path: shotFile, fullPage: true, animations: 'disabled', caret: 'hide',
      mask: cfg.mask.map((s) => page.locator(s)), maskColor: '#FF00FF',
    });
    out.shot = shotFile;
  } catch (e) {
    out.error = String(e.message).split('\n')[0];
    await page.screenshot({ path: shotFile, fullPage: true }).then(() => { out.shot = shotFile; }).catch(() => {});
  }
  await page.close();
  return out;
}

// ---------- comparing the languages ----------

const comparable = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const hasWords = (t) => /\p{L}{3,}/u.test(t);
const relOut = (cfg, f) => path.relative(cfg.outDir, f).split(path.sep).join('/');

function compareLanguages(results, codes) {
  // Align texts and attributes by their structural path.
  const rows = new Map();
  for (const code of codes) {
    const r = results[code];
    for (const item of [...(r.texts ?? []), ...(r.attrs ?? [])]) {
      if (!rows.has(item.path)) rows.set(item.path, {});
      const row = rows.get(item.path);
      // "[sr] " marks visually hidden text that only screen readers announce.
      const text = item.srOnly ? `[sr] ${item.text}` : item.text;
      row[code] = row[code] ? `${row[code]} | ${text}` : text;
    }
  }
  const identical = [];
  const onlyIn = [];
  for (const [p, row] of rows) {
    const present = codes.filter((c) => row[c] !== undefined);
    if (present.length < codes.length) onlyIn.push({ path: p, langs: present, text: row[present[0]].slice(0, 120) });
    const groups = new Map();
    for (const c of present) {
      if (!hasWords(row[c])) continue;
      const k = comparable(row[c]);
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    for (const langs of groups.values()) {
      if (langs.length >= 2) identical.push({ path: p, langs, text: row[langs[0]].slice(0, 160) });
    }
  }
  const metaSame = [];
  for (const key of ['title', 'description', 'ogTitle']) {
    const vals = codes.map((c) => results[c].meta?.[key]).filter((v) => v && hasWords(v));
    if (vals.length >= 2 && new Set(vals.map(comparable)).size < vals.length) {
      metaSame.push({ key, values: Object.fromEntries(codes.map((c) => [c, results[c].meta?.[key] ?? null])) });
    }
  }
  return { rows, identical, onlyIn, metaSame };
}

function writeTsv(file, rows, codes) {
  const cell = (s) => (s ?? '').replace(/[\t\r\n]+/g, ' ');
  const lines = [['path', ...codes].join('\t')];
  for (const [p, row] of rows) lines.push([p, ...codes.map((c) => cell(row[c]))].join('\t'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

// ---------- images (composed in a browser canvas) ----------

// panels: [{ file, crop: [x, y, w, h] | null, label, highlight }]. Without crop, the top of the
// screenshot (up to maxH) is used. Writes one PNG with the panels side by side and a label above each.
async function compose(helper, panels, outFile, maxH) {
  const data = panels.map((p) => ({
    img: p.file && fs.existsSync(p.file) ? fs.readFileSync(p.file).toString('base64') : null,
    crop: p.crop ?? null, label: p.label, highlight: Boolean(p.highlight),
  }));
  const b64 = await helper.evaluate(async ({ data, maxH }) => {
    const load = async (s) => {
      if (!s) return null;
      const img = new Image();
      img.src = `data:image/png;base64,${s}`;
      await img.decode();
      return img;
    };
    const imgs = await Promise.all(data.map((d) => load(d.img)));
    const boxes = data.map((d, i) => {
      const img = imgs[i];
      if (!img) return { x: 0, y: 0, w: 360, h: 120 };
      let [x, y, w, h] = d.crop ?? [0, 0, img.width, img.height];
      x = Math.max(0, Math.min(x, img.width - 1));
      y = Math.max(0, Math.min(y, img.height - 1));
      w = Math.max(1, Math.min(w, img.width - x));
      h = Math.max(1, Math.min(h, img.height - y, maxH));
      return { x, y, w, h };
    });
    const GAP = 16;
    const HEAD = 40;
    const W = boxes.reduce((s, b) => s + b.w, 0) + GAP * (boxes.length + 1);
    const H = Math.max(...boxes.map((b) => b.h)) + HEAD + GAP;
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f6f8fa';
    ctx.fillRect(0, 0, W, H);
    let x = GAP;
    data.forEach((d, i) => {
      const b = boxes[i];
      ctx.fillStyle = '#1f2328';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText(d.label, x, 27, b.w);
      if (imgs[i]) {
        ctx.drawImage(imgs[i], b.x, b.y, b.w, b.h, x, HEAD, b.w, b.h);
      } else {
        ctx.fillStyle = '#8d96a0';
        ctx.font = '16px sans-serif';
        ctx.fillText('—', x + 8, HEAD + 30);
      }
      ctx.strokeStyle = d.highlight ? 'rgb(230,20,60)' : '#d0d7de';
      ctx.lineWidth = d.highlight ? 3 : 1;
      ctx.strokeRect(x - 1.5, HEAD - 1.5, b.w + 3, b.h + 3);
      x += b.w + GAP;
    });
    const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }, { data, maxH });
  fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
}

// A crop around an element: 40 px margin, at least 360 × 120, at most 600 px high.
function cropAround(rect) {
  const [x, y, w, h] = rect;
  const cw = Math.max(w + 80, 360);
  const ch = Math.min(Math.max(h + 80, 120), 600);
  return [Math.round(x + w / 2 - cw / 2), Math.max(0, y - 40), cw, ch];
}

// One image per finding (keys first, then overflow): the same element in every language,
// with a red frame around the languages where the finding occurs.
async function findingImages(helper, cfg, results, dir) {
  const codes = cfg.languages.map((l) => l.code);
  const byElement = new Map();
  const add = (type, kind, code, p, text) => {
    const k = `${type}|${p.replace(/@.*$/, '')}`;
    if (!byElement.has(k)) byElement.set(k, { type, kind, path: p, text, langs: [] });
    if (!byElement.get(k).langs.includes(code)) byElement.get(k).langs.push(code);
  };
  for (const code of codes) {
    for (const k of results[code].keys ?? []) if (!k.srOnly) add('key', k.kind, code, k.path, k.text);
  }
  for (const code of codes) for (const o of results[code].overflow ?? []) add('overflow', o.kinds.join('+'), code, o.path, o.text);

  const images = [];
  let n = 0;
  for (const f of byElement.values()) {
    if (n >= MAX_FINDING_IMAGES) break;
    n++;
    const file = path.join(dir, `finding-${String(n).padStart(2, '0')}-${f.type}.png`);
    const elPath = f.path.replace(/@.*$/, '');
    const panels = cfg.languages.map((l) => {
      const r = results[l.code];
      const item = [...(r.texts ?? []), ...(r.attrs ?? [])].find((t) => t.path.replace(/@.*$/, '') === elPath);
      return { file: item ? r.shot : null, crop: item ? cropAround(item.rect) : null, label: l.code, highlight: f.langs.includes(l.code) };
    });
    await compose(helper, panels, file, 600);
    images.push({ file: relOut(cfg, file), ...f });
  }
  return { images, total: byElement.size };
}

// ---------- main ----------

async function main() {
  if (!process.argv[2]) fail('Usage: node i18n-inspect.js <config.json>');
  const cfg = loadConfig(process.argv[2]);
  const codes = cfg.languages.map((l) => l.code);
  fs.mkdirSync(cfg.outDir, { recursive: true });
  console.log(`Read-only (only GET, HEAD and OPTIONS). Languages: ${cfg.languages.map((l) => `${l.code} (${l.locale})`).join(', ')}`);

  const expected = Object.fromEntries(cfg.languages.map((l) => [l.code, expectedFormats(l.locale, cfg.timezoneId)]));
  const browser = await playwright[cfg.browser].launch();
  const summaryPages = cfg.pages.map((p) => ({ name: p.name, viewports: [] }));
  try {
    const helper = await browser.newPage();
    for (const viewport of cfg.viewports) {
      const contexts = {};
      for (const lang of cfg.languages) contexts[lang.code] = await newContext(browser, cfg, lang, viewport);
      for (const [pi, pageCfg] of cfg.pages.entries()) {
        const dir = path.join(cfg.outDir, 'shots', pageCfg.name, viewport.name);
        const results = {};
        for (const lang of cfg.languages) {
          console.log(`${pageCfg.name} / ${viewport.name} / ${lang.code}: ${urlFor(lang, pageCfg)}`);
          results[lang.code] = await inspectPage(contexts[lang.code], cfg, lang, pageCfg, path.join(dir, `${lang.code}.png`));
        }
        const cmp = compareLanguages(results, codes);
        if (viewport === cfg.viewports[0]) writeTsv(path.join(cfg.outDir, 'texts', `${pageCfg.name}.tsv`), cmp.rows, codes);

        const side = path.join(dir, 'side-by-side.png');
        await compose(helper, cfg.languages.map((l) => ({ file: results[l.code].shot, label: `${l.code} – ${viewport.name}` })), side, SIDE_MAX_H);
        const found = await findingImages(helper, cfg, results, dir);

        const perLang = {};
        for (const lang of cfg.languages) {
          const r = results[lang.code];
          const fmt = checkFormats(r.texts ?? [], lang, expected[lang.code]);
          const strip = ({ rect, ...rest }) => rest;
          perLang[lang.code] = {
            url: r.url, finalUrl: r.finalUrl, status: r.status, error: r.error,
            htmlLang: r.meta?.lang ?? null,
            htmlLangMismatch: r.meta ? !String(r.meta.lang ?? '').toLowerCase().startsWith(lang.code) : null,
            title: r.meta?.title ?? null, description: r.meta?.description ?? null, alternates: r.meta?.alternates ?? [],
            horizontalScroll: r.horizontalScroll ?? null, pageWidth: r.pageWidth ?? null,
            keys: (r.keys ?? []).slice(0, MAX_LIST).map(strip),
            overflow: (r.overflow ?? []).slice(0, MAX_LIST).map(strip),
            formats: fmt.findings, formatSamples: fmt.samples,
            consoleErrors: r.consoleErrors.slice(0, 10),
            counts: {
              texts: r.texts?.length ?? 0, attrs: r.attrs?.length ?? 0, keys: r.keys?.length ?? 0,
              overflow: r.overflow?.length ?? 0, formats: fmt.findings.length, consoleErrors: r.consoleErrors.length,
            },
            shot: r.shot ? relOut(cfg, r.shot) : null,
          };
        }
        summaryPages[pi].viewports.push({
          name: viewport.name, width: viewport.width, height: viewport.height,
          languages: perLang,
          identical: cmp.identical.slice(0, MAX_LIST * 2), identicalCount: cmp.identical.length,
          onlyIn: cmp.onlyIn.slice(0, MAX_LIST), onlyInCount: cmp.onlyIn.length,
          metaSame: cmp.metaSame,
          sideBySide: relOut(cfg, side),
          findingImages: found.images, findingCount: found.total,
        });

        const count = (k) => codes.map((code) => `${code} ${perLang[code].counts[k]}`).join(' ');
        const errs = codes.filter((code) => perLang[code].error || (perLang[code].status ?? 200) >= 400);
        console.log(`  keys: ${count('keys')} | overflow: ${count('overflow')} | formats: ${count('formats')} | identical: ${cmp.identical.length}`
          + ` | h-scroll: ${codes.filter((code) => perLang[code].horizontalScroll).join(',') || '-'}`
          + ` | lang attr wrong: ${codes.filter((code) => perLang[code].htmlLangMismatch).join(',') || '-'}`
          + `${errs.length ? ` | ERROR on ${errs.map((code) => `${code} (${perLang[code].error ?? perLang[code].status})`).join(', ')}` : ''}`);
      }
      for (const ctx of Object.values(contexts)) await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const summary = {
    name: cfg.name,
    generatedAt: new Date().toISOString(),
    note: 'texts/<page>.tsv aligns all visible texts and attributes per structural path (first viewport). '
      + '"identical" = same text in 2+ languages: a candidate for a missing translation (brand names, codes and proper nouns are expected).',
    settings: { browser: cfg.browser, timezoneId: cfg.timezoneId, viewports: cfg.viewports, mask: cfg.mask },
    languages: cfg.languages.map((l) => ({ code: l.code, locale: l.locale, url: l.base, cookies: l.cookies.map((c) => c.name), expected: expected[l.code] })),
    pages: summaryPages,
  };
  fs.writeFileSync(path.join(cfg.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`Summary: ${path.join(cfg.outDir, 'summary.json')}`);
}

main().catch((e) => fail(e.stack || String(e)));

// Generates a self-contained HTML bug report (styled after the Playwright HTML report)
// from .txt bug tickets, and copies the tickets and their attachments next to it.
//
// Usage: node generate.js <config.json>
// config.json:
// {
//   "outDir": "bugs/reports/2026-11-05_10-30_alle-bugs",   // created, must not exist yet
//   "title": "Bugrapport",                                 // optional
//   "lang": "nl" | "en",
//   "tickets": [
//     { "file": "bugs/2026-11-04_12-27_x.txt", "attachments": ["bugs/media/x.png"] }
//   ]
// }
'use strict';

const fs = require('fs');
const path = require('path');

const LABELS = {
  nl: {
    all: 'Alle', search: 'Zoeken', bug: 'bug', bugs: 'bugs', generated: 'Gegenereerd op', back: 'Alle bugs',
    severity: 'Ernst', priority: 'Prioriteit', media: "Screenshots en video's", files: 'Bestanden',
    ticket: 'Origineel ticket', noResults: 'Geen bugs gevonden.',
    levels: { critical: 'Kritiek', major: 'Groot', minor: 'Klein', trivial: 'Triviaal', unknown: 'Onbekend' },
  },
  en: {
    all: 'All', search: 'Search', bug: 'bug', bugs: 'bugs', generated: 'Generated on', back: 'All bugs',
    severity: 'Severity', priority: 'Priority', media: 'Screenshots and videos', files: 'Files',
    ticket: 'Original ticket', noResults: 'No bugs found.',
    levels: { critical: 'Critical', major: 'Major', minor: 'Minor', trivial: 'Trivial', unknown: 'Unknown' },
  },
};

// Headers of the bug-create-report template, in order. Severity and priority are "Header: value" lines.
const FORMAT = {
  nl: {
    headers: ['Probleembeschrijving', 'Stappen om te reproduceren', 'Verwacht resultaat', 'Werkelijk resultaat', 'Ernst',
      'Prioriteit', 'Tijdstip van optreden', 'Statistieken', 'Workaround', 'Omgevingsinformatie', 'Aanvullende informatie', 'Bijlagen'],
    severity: 'Ernst', priority: 'Prioriteit',
    list: ['Stappen om te reproduceren'], kv: ['Statistieken', 'Omgevingsinformatie', 'Aanvullende informatie'],
  },
  en: {
    headers: ['Problem Description', 'Steps to reproduce', 'Expected result', 'Actual result', 'Severity',
      'Priority', 'Timestamp of occurrence', 'Statistics', 'Workaround', 'Environmental Information', 'Additional Information', 'Attachments'],
    severity: 'Severity', priority: 'Priority',
    list: ['Steps to reproduce'], kv: ['Statistics', 'Environmental Information', 'Additional Information'],
  },
};

const SEVERITY_LEVELS = { kritiek: 'critical', critical: 'critical', groot: 'major', major: 'major',
  klein: 'minor', minor: 'minor', triviaal: 'trivial', trivial: 'trivial' };
// Priority uses the same colours: high orange, medium yellow, low grey.
const PRIORITY_LEVELS = { hoog: 'major', high: 'major', middel: 'minor', medium: 'minor', laag: 'trivial', low: 'trivial' };

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
const VIDEO_EXT = ['.mp4', '.webm', '.ogg', '.mov', '.m4v'];

const kvMatch = (line) => line.match(/^([^:]{1,40}):\s+(.+)$/);

// Parses a ticket in the bug-create-report format (Dutch or English).
// Returns { ticket } or { errors } when the ticket does not follow the format.
function parseTicket(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const lang = lines.includes('Problem Description:') ? 'en' : 'nl';
  const tpl = FORMAT[lang];
  const errors = [];

  const titleIndex = lines.findIndex((l) => l !== '');
  const title = titleIndex >= 0 ? lines[titleIndex] : '';
  if (!title || title.endsWith(':')) errors.push('the first line is not a title');

  const sections = [];
  const found = new Set();
  let severity = '';
  let priority = '';
  let current = null;
  for (const line of lines.slice(titleIndex + 1)) {
    if (line === '') continue;
    const header = tpl.headers.find((h) => line === `${h}:`);
    const single = [tpl.severity, tpl.priority].find((h) => line.startsWith(`${h}: `));
    if (single) {
      found.add(single);
      const value = line.slice(single.length + 2).trim();
      if (single === tpl.severity) severity = value; else priority = value;
      current = null;
    } else if (header && header !== tpl.severity && header !== tpl.priority) {
      found.add(header);
      current = { header, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      errors.push(`text outside a section: "${line.slice(0, 60)}"`);
    }
  }
  const missing = tpl.headers.filter((h) => !found.has(h));
  if (missing.length) errors.push(`missing fields: ${missing.join(', ')}`);
  if (errors.length) {
    // Keep the message readable: at most three examples of text outside a section.
    const outside = errors.filter((e) => e.startsWith('text outside'));
    const other = errors.filter((e) => !e.startsWith('text outside'));
    const shown = outside.slice(0, 3).concat(outside.length > 3 ? [`${outside.length - 3} more lines outside a section`] : []);
    return { errors: [...other, ...shown] };
  }

  for (const section of sections) {
    if (tpl.list.includes(section.header) && section.lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      section.kind = 'list';
      section.items = section.lines.map((l) => l.replace(/^\d+[.)]\s+/, ''));
    } else if (tpl.kv.includes(section.header)) {
      // Sub-fields ("Browser: Chrome") become table rows, other lines stay text.
      section.kind = 'kv';
      section.items = section.lines.map((l) => {
        const m = kvMatch(l);
        return m ? { key: m[1].trim(), value: m[2].trim() } : { text: l };
      });
    } else {
      section.kind = 'text';
      section.items = section.lines;
    }
    delete section.lines;
  }
  return {
    ticket: {
      title, lang, sections, severity, priority,
      severityLevel: SEVERITY_LEVELS[severity.toLowerCase()] ?? 'unknown',
      priorityLevel: PRIORITY_LEVELS[priority.toLowerCase()] ?? 'unknown',
    },
  };
}

function attachmentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'file';
}

// Safe, readable file name for the copy in the report folder.
function safeName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node generate.js <config.json>');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const lang = config.lang === 'en' ? 'en' : 'nl';
  const labels = LABELS[lang];
  const outDir = path.resolve(config.outDir);
  if (fs.existsSync(outDir)) throw new Error(`Output folder already exists: ${outDir}`);

  // Validate every ticket and attachment before anything is written.
  const problems = [];
  const parsed = config.tickets.map((entry) => {
    const result = parseTicket(fs.readFileSync(entry.file, 'utf8'));
    if (result.errors) problems.push(`${entry.file}: not in the bug-create-report format (${result.errors.join('; ')})`);
    for (const src of entry.attachments || []) {
      if (!fs.existsSync(src)) problems.push(`${entry.file}: attachment not found: ${src}`);
    }
    return result.ticket;
  });
  if (problems.length) throw new Error(`Nothing was written.\n${problems.join('\n')}`);

  fs.mkdirSync(path.join(outDir, 'tickets'), { recursive: true });
  const tickets = config.tickets.map((entry, index) => {
    const base = path.basename(entry.file, '.txt');
    fs.copyFileSync(entry.file, path.join(outDir, 'tickets', `${base}.txt`));
    const dateMatch = base.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/);
    const attachments = (entry.attachments || []).map((src) => {
      const name = safeName(path.basename(src));
      const rel = `attachments/${base}/${name}`;
      fs.mkdirSync(path.join(outDir, 'attachments', base), { recursive: true });
      fs.copyFileSync(src, path.join(outDir, rel));
      return { name: path.basename(src), path: rel, type: attachmentType(src) };
    });
    return {
      id: String(index + 1),
      file: `tickets/${base}.txt`,
      date: dateMatch ? `${dateMatch[1]} ${dateMatch[2]}:${dateMatch[3]}` : '',
      attachments,
      ...parsed[index],
    };
  });

  const order = ['critical', 'major', 'minor', 'trivial', 'unknown'];
  tickets.sort((a, b) => order.indexOf(a.severityLevel) - order.indexOf(b.severityLevel) || b.date.localeCompare(a.date));

  const data = {
    title: config.title || (lang === 'en' ? 'Bug report' : 'Bugrapport'),
    generated: localTimestamp(new Date()),
    labels,
    tickets,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = TEMPLATE.replace('__LANG__', lang).replace('__TITLE__', escapeHtml(data.title)).replace('__DATA__', json);
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  console.log(`Report: ${path.join(outDir, 'index.html')} (${tickets.length} tickets, ${tickets.reduce((n, t) => n + t.attachments.length, 0)} attachments)`);
}

// Local time as YYYY-MM-DD HH:mm (the time the reader sees on their own clock).
function localTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const TEMPLATE = `<!doctype html>
<html lang="__LANG__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root {
  --bg: #ffffff; --bg-subtle: #f6f8fa; --bg-hover: #eaeef2; --fg: #1f2328; --fg-muted: #59636e;
  --border: #d0d7de; --accent: #0969da;
  --critical: #d1242f; --major: #bc4c00; --minor: #9a6700; --trivial: #59636e; --unknown: #8c959f;
  --chip-selected: #ddf4ff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --bg-subtle: #161b22; --bg-hover: #21262d; --fg: #e6edf3; --fg-muted: #9198a1;
    --border: #30363d; --accent: #4493f8;
    --critical: #f85149; --major: #db6d28; --minor: #d29922; --trivial: #9198a1; --unknown: #6e7681;
    --chip-selected: #1f3a5f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.container { max-width: 1024px; margin: 0 auto; padding: 16px; }
.header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.header h1 { font-size: 20px; margin: 0; font-weight: 600; }
.meta { color: var(--fg-muted); font-size: 12px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 16px; }
.chips { display: flex; flex-wrap: wrap; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.chip { display: flex; gap: 6px; align-items: center; padding: 5px 12px; background: var(--bg); color: var(--fg);
  border: 0; border-right: 1px solid var(--border); cursor: pointer; font: inherit; }
.chip:last-child { border-right: 0; } .chip:hover { background: var(--bg-hover); }
.chip.selected { background: var(--chip-selected); font-weight: 600; }
.count { background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 10px; padding: 0 7px; font-size: 12px; }
.search { flex: 1; min-width: 180px; padding: 5px 12px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--fg); font: inherit; }
.box { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; margin-bottom: 16px; }
.box-header { background: var(--bg-subtle); padding: 8px 16px; border-bottom: 1px solid var(--border); font-weight: 600;
  display: flex; justify-content: space-between; gap: 8px; }
.row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 16px; border-bottom: 1px solid var(--border);
  cursor: pointer; color: var(--fg); }
.row:last-child { border-bottom: 0; } .row:hover { background: var(--bg-hover); text-decoration: none; }
.row-main { flex: 1; min-width: 0; } .row-title { font-weight: 500; overflow-wrap: anywhere; }
.row-sub { color: var(--fg-muted); font-size: 12px; margin-top: 2px; }
.row-side { color: var(--fg-muted); font-size: 12px; white-space: nowrap; }
.dot { width: 12px; height: 12px; border-radius: 50%; flex: none; margin-top: 4px; background: var(--unknown); }
.badge { display: inline-block; padding: 0 8px; border-radius: 10px; font-size: 12px; font-weight: 500; border: 1px solid currentColor; }
.lvl-critical { color: var(--critical); } .dot.lvl-critical { background: var(--critical); }
.lvl-major { color: var(--major); } .dot.lvl-major { background: var(--major); }
.lvl-minor { color: var(--minor); } .dot.lvl-minor { background: var(--minor); }
.lvl-trivial { color: var(--trivial); } .dot.lvl-trivial { background: var(--trivial); }
.lvl-unknown { color: var(--unknown); } .dot.lvl-unknown { background: var(--unknown); }
.badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.back { display: inline-block; margin-bottom: 12px; }
.detail-title { font-size: 20px; font-weight: 600; margin: 0 0 4px; overflow-wrap: anywhere; }
.box-body { padding: 12px 16px; }
.box-body p { margin: 0 0 6px; overflow-wrap: anywhere; } .box-body p:last-child { margin-bottom: 0; }
.box-body ol { margin: 0; padding-left: 22px; }
table.kv { border-collapse: collapse; width: 100%; }
table.kv td { padding: 4px 8px 4px 0; vertical-align: top; overflow-wrap: anywhere; }
table.kv td:first-child { color: var(--fg-muted); width: 200px; white-space: nowrap; }
.muted { color: var(--fg-muted); font-style: italic; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.gallery figure { margin: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--bg-subtle); }
.gallery img, .gallery video { display: block; width: 100%; max-height: 360px; object-fit: contain; background: #000; }
.gallery figcaption { padding: 6px 8px; font-size: 12px; overflow-wrap: anywhere; }
.empty { padding: 24px 16px; color: var(--fg-muted); text-align: center; }
@media (max-width: 600px) { table.kv td:first-child { width: auto; white-space: normal; } .row-side { display: none; } }
</style>
</head>
<body>
<div class="container" id="app"></div>
<script id="report-data" type="application/json">__DATA__</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('report-data').textContent);
  var L = data.labels;
  var app = document.getElementById('app');
  var LEVELS = ['critical', 'major', 'minor', 'trivial', 'unknown'];
  var EMPTY = ['niet opgegeven', 'not provided'];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k]; else if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }
  // Text with http(s) links made clickable; everything else stays plain text.
  function rich(text) {
    var span = el('span');
    if (EMPTY.indexOf(String(text).trim().toLowerCase()) >= 0) { span.className = 'muted'; span.textContent = text; return span; }
    String(text).split(/(https?:\\/\\/[^\\s]+)/).forEach(function (part) {
      if (/^https?:\\/\\//.test(part)) span.appendChild(el('a', { href: part, target: '_blank', rel: 'noopener', text: part }));
      else if (part) span.appendChild(document.createTextNode(part));
    });
    return span;
  }
  function badge(level, label, value) {
    return value ? el('span', { class: 'badge lvl-' + level, text: label + ': ' + value }) : null;
  }
  function route() {
    var m = location.hash.match(/id=([^&]+)/);
    var q = location.hash.match(/q=([^&]*)/);
    var s = location.hash.match(/s=([^&]+)/);
    return { id: m ? decodeURIComponent(m[1]) : null, q: q ? decodeURIComponent(q[1]) : '', s: s ? s[1] : 'all' };
  }
  function setHash(r) {
    var parts = [];
    if (r.s && r.s !== 'all') parts.push('s=' + r.s);
    if (r.q) parts.push('q=' + encodeURIComponent(r.q));
    location.hash = parts.length ? '?' + parts.join('&') : '';
  }

  function renderList(r) {
    var counts = { all: data.tickets.length };
    LEVELS.forEach(function (l) { counts[l] = data.tickets.filter(function (t) { return t.severityLevel === l; }).length; });
    var chips = el('div', { class: 'chips' });
    ['all'].concat(LEVELS).forEach(function (l) {
      if (l !== 'all' && counts[l] === 0) return;
      var chip = el('button', { class: 'chip' + (r.s === l ? ' selected' : '') }, [
        l === 'all' ? null : el('span', { class: 'dot lvl-' + l, style: 'margin-top:0' }),
        l === 'all' ? L.all : L.levels[l], el('span', { class: 'count', text: String(counts[l]) })]);
      chip.onclick = function () { setHash({ s: l, q: r.q }); };
      chips.appendChild(chip);
    });
    var search = el('input', { class: 'search', type: 'search', placeholder: L.search, value: r.q, 'aria-label': L.search });
    search.oninput = function () { setHash({ s: r.s, q: search.value }); };

    var q = r.q.toLowerCase();
    var shown = data.tickets.filter(function (t) {
      if (r.s !== 'all' && t.severityLevel !== r.s) return false;
      return !q || JSON.stringify(t).toLowerCase().indexOf(q) >= 0;
    });
    var box = el('div', { class: 'box' }, [el('div', { class: 'box-header' }, [
      el('span', { text: data.title }), el('span', { class: 'meta', text: shown.length + ' ' + (shown.length === 1 ? L.bug : L.bugs) })])]);
    shown.forEach(function (t) {
      var row = el('a', { class: 'row', href: '#?id=' + encodeURIComponent(t.id) }, [
        el('span', { class: 'dot lvl-' + t.severityLevel, title: t.severity || L.levels.unknown }),
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title', text: t.title || t.file }),
          el('div', { class: 'badges' }, [badge(t.severityLevel, L.severity, t.severity), badge(t.priorityLevel, L.priority, t.priority),
            t.attachments.length ? el('span', { class: 'row-sub', text: '📎 ' + t.attachments.length }) : null])]),
        el('div', { class: 'row-side', text: t.date })]);
      box.appendChild(row);
    });
    if (shown.length === 0) box.appendChild(el('div', { class: 'empty', text: L.noResults }));

    app.replaceChildren(
      el('div', { class: 'header' }, [el('h1', { text: data.title }), el('span', { class: 'meta', text: L.generated + ' ' + data.generated })]),
      el('div', { class: 'toolbar' }, [chips, search]), box);
    if (r.q) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  function section(header, body) {
    return el('div', { class: 'box' }, [header ? el('div', { class: 'box-header', text: header }) : null, el('div', { class: 'box-body' }, [body])]);
  }

  function renderDetail(t) {
    var parts = [
      el('a', { class: 'back', href: '#' , text: '← ' + L.back }),
      el('h2', { class: 'detail-title', text: t.title || t.file }),
      el('div', { class: 'badges', style: 'margin-bottom:16px' }, [badge(t.severityLevel, L.severity, t.severity),
        badge(t.priorityLevel, L.priority, t.priority), t.date ? el('span', { class: 'meta', text: t.date }) : null])];
    t.sections.forEach(function (s) {
      var body;
      if (s.kind === 'list') {
        body = el('ol'); s.items.forEach(function (i) { body.appendChild(el('li', {}, [rich(i)])); });
      } else if (s.kind === 'kv') {
        // Sub-fields as a table, free text lines (e.g. in Additional Information) below it.
        var table = el('table', { class: 'kv' });
        body = el('div', {}, [table]);
        s.items.forEach(function (i) {
          if (i.key) table.appendChild(el('tr', {}, [el('td', { text: i.key }), el('td', {}, [rich(i.value)])]));
          else body.appendChild(el('p', { style: 'margin-top:6px' }, [rich(i.text)]));
        });
      } else {
        body = el('div'); s.items.forEach(function (i) { body.appendChild(el('p', {}, [rich(i)])); });
      }
      parts.push(section(s.header, body));
    });
    var media = t.attachments.filter(function (a) { return a.type !== 'file'; });
    var files = t.attachments.filter(function (a) { return a.type === 'file'; });
    if (media.length) {
      var gallery = el('div', { class: 'gallery' });
      media.forEach(function (a) {
        var view = a.type === 'image'
          ? el('a', { href: a.path, target: '_blank', rel: 'noopener' }, [el('img', { src: a.path, alt: a.name, loading: 'lazy' })])
          : el('video', { src: a.path, controls: '', preload: 'metadata' });
        gallery.appendChild(el('figure', {}, [view, el('figcaption', {}, [el('a', { href: a.path, target: '_blank', rel: 'noopener', text: a.name })])]));
      });
      parts.push(section(L.media, gallery));
    }
    var fileList = el('div');
    files.forEach(function (a) { fileList.appendChild(el('p', {}, [el('a', { href: a.path, target: '_blank', rel: 'noopener', text: a.name })])); });
    fileList.appendChild(el('p', {}, [el('a', { href: t.file, target: '_blank', rel: 'noopener', text: L.ticket + ' (' + t.file.split('/').pop() + ')' })]));
    parts.push(section(L.files, fileList));
    app.replaceChildren.apply(app, parts);
    window.scrollTo(0, 0);
  }

  function render() {
    var r = route();
    var ticket = r.id && data.tickets.find(function (t) { return t.id === r.id; });
    if (ticket) renderDetail(ticket); else renderList(r);
  }
  window.addEventListener('hashchange', render);
  render();
})();
</script>
</body>
</html>
`;

main();

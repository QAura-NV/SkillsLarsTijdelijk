#!/usr/bin/env node
// Sums the token usage of the current Claude Code session since a given moment.
// Reads the session transcripts that Claude Code writes to ~/.claude/projects/<project>/.
//
// Usage: node tokens.js --since <ISO timestamp> [--until <ISO timestamp>] [--json]
//   --since  start of the hunt session (e.g. the output of `date -u +%Y-%m-%dT%H:%M:%SZ`)
//   --until  end of the hunt session (default: now)
//   --json   print JSON instead of a table
//
// Only reads files, never writes. Counts each API message once (the transcript repeats a
// message once per content block), and includes subagent transcripts of the session.

const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const since = arg('since') ? new Date(arg('since')) : undefined;
const until = arg('until') ? new Date(arg('until')) : new Date();
const asJson = process.argv.includes('--json');

if (!since || isNaN(since.getTime())) {
  console.error('Missing or invalid --since <ISO timestamp>');
  process.exit(1);
}

// Claude Code names the project folder after the working directory: every ':', '\' and '/' becomes '-'.
const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const wanted = process.cwd().replace(/[:\\/]/g, '-').toLowerCase();
const projectName = fs.readdirSync(projectsDir).find((d) => d.toLowerCase() === wanted);
if (!projectName) {
  console.error(`No transcript folder found for ${process.cwd()} in ${projectsDir}`);
  process.exit(1);
}
const projectDir = path.join(projectsDir, projectName);

// The current session is the transcript that was written to last.
const sessions = fs
  .readdirSync(projectDir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
if (sessions.length === 0) {
  console.error(`No session transcripts in ${projectDir}`);
  process.exit(1);
}
const sessionFile = path.join(projectDir, sessions[0].f);
const sessionId = path.basename(sessionFile, '.jsonl');

// Subagent transcripts, if any, live in a folder named after the session.
const files = [sessionFile];
const subDir = path.join(projectDir, sessionId);
if (fs.existsSync(subDir)) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(subDir);
}

const totals = { messages: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const byModel = {};
const seen = new Set();

for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message;
    if (!msg || !msg.usage || !entry.timestamp) continue;
    const t = new Date(entry.timestamp);
    if (t < since || t > until) continue;
    const key = msg.id || entry.requestId || entry.uuid;
    if (seen.has(key)) continue;
    seen.add(key);

    const u = msg.usage;
    const row = {
      input: u.input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
    };
    totals.messages += 1;
    for (const k of Object.keys(row)) totals[k] += row[k];
    const model = msg.model || 'unknown';
    byModel[model] = byModel[model] || { messages: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    byModel[model].messages += 1;
    for (const k of Object.keys(row)) byModel[model][k] += row[k];
  }
}

const total = totals.input + totals.cacheWrite + totals.cacheRead + totals.output;
const result = {
  session: sessionId,
  since: since.toISOString(),
  until: until.toISOString(),
  ...totals,
  total,
  byModel,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const n = (x) => x.toLocaleString('nl-BE');
  console.log(`Sessie:            ${sessionId}`);
  console.log(`Periode:           ${result.since} - ${result.until}`);
  console.log(`API-berichten:     ${n(totals.messages)}`);
  console.log(`Input (nieuw):     ${n(totals.input)}`);
  console.log(`Cache geschreven:  ${n(totals.cacheWrite)}`);
  console.log(`Cache gelezen:     ${n(totals.cacheRead)}`);
  console.log(`Output:            ${n(totals.output)}`);
  console.log(`Totaal:            ${n(total)}`);
  for (const [model, m] of Object.entries(byModel)) {
    console.log(`  ${model}: ${n(m.messages)} berichten, ${n(m.input + m.cacheWrite + m.cacheRead + m.output)} tokens`);
  }
}

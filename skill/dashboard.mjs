#!/usr/bin/env node
// Live, read-only dashboard for a crew run: boss → orchestrators → drivers → coder/reviewer, plus the event feed.
//   node .claude/skills/crew/dashboard.mjs <run-id | run-dir> [--port 4777]
// Serves on 127.0.0.1 only and never writes anything. It reads the run's files directly (no lib.mjs import), so it
// also works on older run layouts (`.claude/loops/<run>` with PRs and CI).
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';

const STATUS = new Set(['help', 'ready_to_merge', 'needs_replan', 'blocked', 'escalate', 'abandoned', 'merged',
  'needs_human', 'retry', 'replanned', 'rebase_needed']);
const WAITING_ON_BOSS = ['ready_to_merge', 'needs_replan', 'escalate'];

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args.splice(portFlag, 2)[1]) : 4777;
const target = args[0];
if (!target) {
  console.error('usage: dashboard.mjs <run-id | run-dir> [--port 4777]');
  process.exit(2);
}
const RUN_DIR = resolveRunDir(target);
const GITHUB_LAYOUT = RUN_DIR.includes('/.claude/loops/');

function resolveRunDir(t) {
  if (existsSync(join(t, 'events.jsonl')) || existsSync(join(t, 'contracts'))) return t;
  let root = process.cwd();
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch { /* not a repo */ }
  let stateDir = '.claude/crew';
  try { stateDir = JSON.parse(readFileSync(join(root, '.claude/crew.config.json'), 'utf8')).stateDir ?? stateDir; } catch { /* defaults */ }
  for (const dir of [join(root, stateDir, 'runs', t), join(root, '.claude/loops', t)]) if (existsSync(dir)) return dir;
  console.error(`run ${t} not found (looked in ${stateDir}/runs and .claude/loops)`);
  process.exit(2);
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
const alive = (proc) => {
  if (!proc?.pid) return false;
  try { process.kill(proc.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');

function readTail(file, bytes = 256 * 1024) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

// The newest coder/reviewer stream for a task: which role, how many tool calls, and the last thing it did.
function activity(task) {
  const dir = join(RUN_DIR, 'logs', task);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^r\d+-(coder|reviewer)\.jsonl$/.test(f))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  const { f, mtime } = files[0];
  const text = readTail(join(dir, f));
  const lines = text.split('\n').filter(Boolean);
  let last = null;
  let done = false;
  let steps = 0;
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; } // first line of a tail can be partial
    if (msg.type === 'result') done = true;
    if (msg.type !== 'assistant') continue;
    for (const part of msg.message?.content ?? []) {
      if (part.type === 'tool_use') {
        steps++;
        const i = part.input ?? {};
        last = part.name === 'StructuredOutput'
          ? { kind: 'result', text: `returned ${i.status ?? i.verdict ?? 'its result'}` }
          : { kind: 'tool', text: `${part.name}: ${clip(i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.description ?? '', 160)}` };
      } else if (part.type === 'text' && part.text.trim()) last = { kind: 'text', text: clip(part.text.trim(), 200) };
    }
  }
  const [, round, role] = f.match(/^r(\d+)-(\w+)/);
  return { role, round: Number(round), steps, last, done, at: new Date(mtime).toISOString() };
}

// The driver's own last log line ("check gate1: npm test", "round 2: reviewer (opus)") says what it is doing between agents.
function driverStep(task) {
  const file = join(RUN_DIR, 'logs', task, 'driver.log');
  if (!existsSync(file)) return null;
  const line = readTail(file, 8192).trimEnd().split('\n').pop();
  const m = line.match(/^(\S+Z) (.*)$/);
  return m ? { at: m[1], text: clip(m[2], 200) } : null;
}

function eventSummary(e) {
  const d = e.data ?? {};
  return clip(d.reason ?? d.summary ?? (d.verdict ? `${d.step} ${d.verdict}` : null) ?? (d.step ? `${d.step} ${d.status ?? ''}` : null)
    ?? (d.pr ? `PR #${d.pr}` : null) ?? (d.merge ? `merge ${String(d.merge).slice(0, 7)}` : null) ?? (d.tasks ? String(d.tasks) : '') ?? '', 220);
}

function snapshot() {
  const events = existsSync(join(RUN_DIR, 'events.jsonl'))
    ? readFileSync(join(RUN_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];
  const state = {};
  const attempts = {}; // coder rounds across every plan version, so a replan doesn't reset the count
  const replans = {};
  for (const e of events) {
    if (STATUS.has(e.type)) state[e.task] = e.type;
    if (e.type === 'round' && e.data?.step === 'coder') attempts[e.task] = (attempts[e.task] ?? 0) + 1;
    if (e.type === 'replanned') replans[e.task] = (replans[e.task] ?? 0) + 1;
  }

  const contracts = Object.fromEntries(listJson(join(RUN_DIR, 'contracts'))
    .map((f) => readJson(join(RUN_DIR, 'contracts', f))).filter(Boolean).map((c) => [c.id, c]));
  const batches = listJson(join(RUN_DIR, 'batches')).map((f) => {
    const name = basename(f, '.json');
    const b = readJson(join(RUN_DIR, 'batches', f)) ?? { tasks: [] };
    const orch = readJson(join(RUN_DIR, `orch-${name}.json`));
    const tasks = b.tasks.map((id) => {
      const c = contracts[id] ?? { id };
      const d = readJson(join(RUN_DIR, 'drivers', `${id}.json`));
      const o = orch?.drivers?.[id];
      const driverAlive = alive(d?.proc);
      return {
        id, title: c.title, issue: c.issue, version: c.version, models: c.models, depends_on: c.depends_on ?? [],
        state: state[id] ?? 'none', attempts: attempts[id] ?? 0, replans: replans[id] ?? 0, phase: d?.phase ?? null, round: d?.round ?? null, max_rounds: c.max_rounds ?? 3,
        cost: d?.cost ?? 0, head: d?.head?.slice(0, 7) ?? null, pr: d?.pr ?? null,
        driver: d?.proc ? { pid: d.proc.pid, alive: driverAlive } : null, child: driverAlive && alive(d?.child),
        heartbeat: d?.updated ?? null, restarts: o?.restarts ?? 0, triages: o?.triages ?? 0,
        checks: (d?.checks ?? []).map((ch) => ({ id: ch.id, ok: ch.ok })),
        findings: (d?.findings ?? []).slice(0, 3).map((x) => ({ source: x.source, problem: clip(x.problem ?? x.key, 200) })),
        activity: activity(id), step: driverStep(id),
      };
    });
    return { name, max_parallel: b.max_parallel ?? 2, dry_run: !!b.dry_run, orchestrator: orch ? { pid: orch.proc?.pid, alive: alive(orch.proc) } : null, tasks };
  });
  const all = batches.flatMap((b) => b.tasks);
  return {
    run: basename(RUN_DIR), github: GITHUB_LAYOUT,
    phases: GITHUB_LAYOUT ? ['prepare', 'code', 'verify', 'review', 'sync', 'publish', 'ci', 'handoff'] : ['prepare', 'code', 'verify', 'review', 'sync', 'handoff'],
    cost: all.reduce((s, t) => s + t.cost, 0),
    waiting: all.filter((t) => WAITING_ON_BOSS.includes(t.state)).map((t) => ({ id: t.id, state: t.state })),
    batches,
    events: events.slice(-60).reverse().map((e) => {
      const { round, step, status, verdict, open, pr } = e.data ?? {};
      return { ts: e.ts, type: e.type, task: e.task, by: e.by, round, step, status, verdict, open, pr, text: eventSummary(e) };
    }),
  };
}

// Push a fresh snapshot to every open page whenever something changed (checked each second).
const clients = new Set();
let lastSent = '';
setInterval(() => {
  if (!clients.size) return;
  let body;
  try { body = JSON.stringify(snapshot()); } catch (e) { body = JSON.stringify({ error: String(e.message) }); }
  if (body === lastSent) return;
  lastSent = body;
  for (const res of clients) res.write(`data: ${body}\n\n`);
}, 1000);

const PAGE = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  if (req.method !== 'GET') return res.writeHead(405).end();
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE);
  res.writeHead(404).end();
});

let port = PORT;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < PORT + 10) return server.listen(++port, '127.0.0.1');
  console.error(e.message);
  process.exit(1);
});
server.on('listening', () => console.log(`crew dashboard for ${basename(RUN_DIR)}: http://127.0.0.1:${port}`));
server.listen(port, '127.0.0.1');

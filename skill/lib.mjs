// Shared crew plumbing: paths, process control, the event log and its state machine, contracts, locks and
// `claude -p` calls. Everything here is deterministic; judgment lives only in the prompts/ roles and the boss.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL = dirname(fileURLToPath(import.meta.url));
// The host repository: the main checkout of the repo the crew is run from (CREW_ROOT overrides the cwd), so the skill
// works installed in a project's .claude/skills or in ~/.claude/skills.
export const ROOT = dirname(execFileSync('git', ['-C', process.env.CREW_ROOT ?? process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());

export const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

// Optional `crew.config.json` at the repo root. Every field has a default; see docs/configuration.md.
export const CONFIG_DEFAULTS = {
  remote: 'origin',
  main_branch: 'main',
  branch_prefix: 'agent/',
  run_dir: '.claude/loops',
  worktree_dir: '.worktrees',
  locks: ['e2e', 'db'],
  // Paths two tasks may not change unordered, even in different files: lockfiles, migrations, API contracts.
  ordering_paths: ['(^|/)package(-lock)?\\.json$', '(^|/)(pnpm-lock\\.yaml|yarn\\.lock)$', '(^|/)migrations?/'],
  security_paths: 'auth|session|token|secret|security|crypto|password|permission|migration',
  docs_check: null,
  // Optional text appended to every crew commit message (e.g. a trailer) and PR body. Off by default.
  commit_trailer: null,
  pr_footer: null,
  sandbox: { allowed_domains: ['registry.npmjs.org'], extra_write: [] },
};
export function loadConfig(raw = readJson(join(ROOT, 'crew.config.json'), {})) {
  return { ...CONFIG_DEFAULTS, ...raw, sandbox: { ...CONFIG_DEFAULTS.sandbox, ...raw.sandbox } };
}
export const CONFIG = loadConfig();
export const MAIN = `${CONFIG.remote}/${CONFIG.main_branch}`;
export const commitMessage = (subject) => (CONFIG.commit_trailer ? `${subject}\n\n${CONFIG.commit_trailer}` : subject);
export const withFooter = (body) => (CONFIG.pr_footer ? `${body}\n\n${CONFIG.pr_footer}` : body);

export const LOOPS = join(ROOT, CONFIG.run_dir);
export const runDir = (run) => join(LOOPS, run);
export const worktreeOf = (id) => join(ROOT, CONFIG.worktree_dir, id);
export const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tail = (text, n = 40) => text.split('\n').slice(-n).join('\n').trim();
export const log = (...args) => console.log(now(), ...args);
export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n');
  renameSync(file + '.tmp', file);
}

// A crew process is identified by pid + start time, so a recycled pid never passes for one of ours.
export const TOKEN = randomUUID();
export function processStart(pid) {
  if (!pid) return null;
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}
export const identify = (pid) => (pid ? { pid, started: processStart(pid) } : null);
export const isRunning = (proc) => Boolean(proc?.pid && proc.started && processStart(proc.pid) === proc.started);

// Every crew process and child is spawned detached, so it leads its own process group, and signals go to the group
// only (npm, dev servers and claude die with it). A group id can't be taken while any member lives, and a dead leader's
// pid can't lead a new group unless it was recycled, which the start time reveals; then nothing is signalled.
function groupIsOurs(proc) {
  const { pid, started } = typeof proc === 'number' ? { pid: proc } : proc ?? {};
  if (!pid) return null;
  const current = processStart(pid);
  return started && current && current !== started ? null : pid;
}
export function killGroup(proc) {
  const pid = groupIsOurs(proc);
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { return; }
  setTimeout(() => { if (groupIsOurs(proc)) try { process.kill(-pid, 'SIGKILL'); } catch {} }, 10_000).unref();
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function tryGit(cwd, ...args) {
  try { return { ok: true, out: git(cwd, ...args) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message).trim() }; }
}
export function gh(...args) {
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
// Posts an issue comment once. A hidden marker turns a step retried after a crash into a no-op.
export function commentOnce(issue, marker, body) {
  const tag = `<!-- crew:${marker} -->`;
  if (gh('issue', 'view', String(issue), '--json', 'comments', '--jq', '.comments[].body').includes(tag)) return false;
  gh('issue', 'comment', String(issue), '--body', `${body}\n\n${tag}`);
  return true;
}
export async function retry(fn, tries = 3, waitMs = 5000) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(waitMs * i); }
  }
}

// Runs a command with its output in logFile, killing the whole process group after timeoutMin.
export function run(cmd, args, { cwd = ROOT, input, logFile, timeoutMin = 30, env, onSpawn } = {}) {
  mkdirSync(dirname(logFile), { recursive: true });
  return new Promise((resolve) => {
    const fd = openSync(logFile, 'w');
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: [input == null ? 'ignore' : 'pipe', fd, fd] });
    closeSync(fd);
    onSpawn?.(child.pid);
    if (input != null) child.stdin.end(input);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, timeoutMin * 60_000);
    const done = (code) => {
      clearTimeout(timer);
      onSpawn?.(null);
      resolve({ code: timedOut ? 124 : code ?? 1, timedOut, out: tail(readFileSync(logFile, 'utf8')) });
    };
    child.on('error', () => done(127));
    child.on('close', done);
  });
}
export const shell = (command, opts) => run('bash', ['-c', command], opts);

// ---------------------------------------------------------------------------------------------------------------
// Events: `events.jsonl` is the run's append-only bus. A task's state is its last *status* event; the transition
// table refuses illegal moves (e.g. `merged` without `ready_to_merge`). Other event types are informational.

const STARTABLE = ['help', 'ready_to_merge', 'needs_replan', 'blocked', 'escalate', 'abandoned'];
export const TRANSITIONS = {
  none: STARTABLE, retry: STARTABLE, replanned: STARTABLE, rebase_needed: STARTABLE,
  help: ['retry', 'blocked', 'escalate', 'abandoned'],
  ready_to_merge: ['merged', 'needs_human', 'rebase_needed', 'replanned', 'retry', 'abandoned'],
  needs_replan: ['replanned', 'blocked', 'abandoned'],
  escalate: ['replanned', 'retry', 'blocked', 'abandoned'],
  blocked: ['replanned', 'retry', 'abandoned'],
  merged: [], needs_human: [], abandoned: [],
};
export const RUNNABLE = new Set(['none', 'retry', 'replanned', 'rebase_needed']);
export const WAITING_ON_BOSS = new Set(['ready_to_merge', 'needs_replan', 'escalate']);
export const FINISHED = new Set(['merged', 'needs_human', 'abandoned', 'blocked']);
export const DONE_FOR_DEPENDANTS = new Set(['merged', 'needs_human']);

const eventsFile = (run) => join(runDir(run), 'events.jsonl');
export function readEvents(run) {
  const file = eventsFile(run);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
export function lastStatus(events, task) {
  let last = null;
  for (const e of events) if (e.task === task && e.type in TRANSITIONS) last = e;
  return last;
}
export const taskState = (events, task) => lastStatus(events, task)?.type ?? 'none';
export function checkTransition(from, to) {
  if (!(to in TRANSITIONS)) return null;
  return TRANSITIONS[from].includes(to) ? null : `illegal transition ${from} → ${to}`;
}
export function appendEvent(run, type, task, data = {}, by = 'boss') {
  if (task !== '-') {
    const error = checkTransition(taskState(readEvents(run), task), type);
    if (error) throw new Error(`${task}: ${error}`);
  }
  mkdirSync(runDir(run), { recursive: true });
  appendFileSync(eventsFile(run), JSON.stringify({ ts: now(), type, task, by, data }) + '\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Contracts: `contracts/<id>.json` is the machine half of a contract (the `.md` beside it is the prose the coder and
// reviewer read). See references/contract-json.md.

export const MODELS = ['haiku', 'sonnet', 'opus'];
export const DEFAULTS = {
  depends_on: [], setup: [], checks: [], gates: [], e2e: [], locks: [], docs: [], max_rounds: 3,
  manual_acceptance: null, issue_comment: null,
  models: { coder: 'haiku', reviewer: 'sonnet' },
  budget_usd: { coder: 5, reviewer: 2, triage: 1 },
  timeout_min: { setup: 20, coder: 45, reviewer: 20, checks: 30, e2e: 40, ci: 45 },
};
export function withDefaults(raw) {
  const c = { ...DEFAULTS, ...raw };
  c.models = { ...DEFAULTS.models, ...raw.models };
  c.budget_usd = { ...DEFAULTS.budget_usd, ...raw.budget_usd };
  c.timeout_min = { ...DEFAULTS.timeout_min, ...raw.timeout_min };
  c.locks = [...new Set([...c.locks, ...(c.e2e.length ? ['e2e'] : [])])];
  c.refs_only = Boolean(c.manual_acceptance) || !c.pr?.closes_issue;
  return c;
}
export const contractPath = (run, id, ext = 'json') => join(runDir(run), 'contracts', `${id}.${ext}`);
export const loadContract = (run, id) => withDefaults(readJson(contractPath(run, id)));
export const loadBatch = (run, batch) => ({ max_parallel: 2, dry_run: false, ...readJson(join(runDir(run), 'batches', `${batch}.json`)) });

// Pure shape check of one contract; returns error strings.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function shapeErrors(c, { dryRun = false, config = CONFIG } = {}) {
  const branchRule = new RegExp(`^${escape(config.branch_prefix)}[A-Za-z0-9._/-]+$`);
  const errors = [];
  const need = (ok, msg) => { if (!ok) errors.push(`${c.id ?? '?'}: ${msg}`); };
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  need(str(c.id), 'id missing');
  need(Number.isInteger(c.version) && c.version >= 1, 'version must be an integer ≥ 1');
  need(Number.isInteger(c.issue) || (dryRun && c.issue == null), 'issue must be an issue number');
  for (const k of ['title', 'batch', 'commit']) need(str(c[k]), `${k} missing`);
  need(str(c.branch) && branchRule.test(c.branch), `branch must be ${config.branch_prefix}<plan-id>-<slug>`);
  need(MODELS.includes(c.models?.coder) && MODELS.includes(c.models?.reviewer), `models.coder/reviewer must be one of ${MODELS}`);
  need(Array.isArray(c.allowed_files) && c.allowed_files.length > 0, 'allowed_files is empty');
  for (const f of c.allowed_files ?? []) need(str(f.path) && ['edit', 'create', 'delete'].includes(f.op), `bad allowed_files entry ${JSON.stringify(f)}`);
  for (const ch of c.checks) need(str(ch.id) && str(ch.cmd) && Number.isInteger(ch.expect_exit), `bad check ${JSON.stringify(ch)}`);
  need(c.checks.length + c.gates.length > 0, 'no checks or gates: nothing deterministic proves the change');
  for (const g of [...c.gates, ...c.setup]) need(str(g), 'empty gate/setup command');
  for (const e of c.e2e) need(str(e.id) && str(e.cmd), `bad e2e entry ${JSON.stringify(e)}`);
  for (const l of c.locks) need(config.locks.includes(l), `unknown lock ${l} (crew.config.json locks: ${config.locks.join(', ')})`);
  need(Number.isInteger(c.max_rounds) && c.max_rounds >= 1 && c.max_rounds <= 5, 'max_rounds must be 1–5');
  for (const [k, v] of Object.entries(c.budget_usd)) need(typeof v === 'number' && v > 0, `budget_usd.${k} must be > 0`);
  for (const [k, v] of Object.entries(c.timeout_min)) need(typeof v === 'number' && v > 0, `timeout_min.${k} must be > 0`);
  need(str(c.pr?.title) && str(c.pr?.summary) && typeof c.pr?.closes_issue === 'boolean', 'pr needs title, summary, closes_issue');
  for (const d of c.docs) need(str(d.file) && str(d.find) && typeof d.replace === 'string', `bad docs entry for ${d.file}`);
  return errors;
}

// Tasks whose files overlap (or that both touch one project's ordering paths: lockfiles, migrations, API contracts)
// must be ordered by depends_on, otherwise two drivers would race on the same lines.
export function orderingErrors(contracts, { config = CONFIG } = {}) {
  const ordering = config.ordering_paths.map((p) => new RegExp(p));
  const sensitive = (path) => ordering.some((re) => re.test(path));
  const errors = [];
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const ancestors = new Map();
  const visit = (id, stack = []) => {
    if (stack.includes(id)) { errors.push(`dependency cycle: ${[...stack, id].join(' → ')}`); return new Set(); }
    if (ancestors.has(id)) return ancestors.get(id);
    const acc = new Set();
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue; // dependencies outside the run are checked by the caller
      acc.add(dep);
      for (const a of visit(dep, [...stack, id])) acc.add(a);
    }
    ancestors.set(id, acc);
    return acc;
  };
  contracts.forEach((c) => visit(c.id));
  // "Project" = the top-level directory (or the root, for files there).
  const project = (path) => (path.includes('/') ? path.split('/')[0] : '.');
  const sensitiveProjects = (c) => new Set(c.allowed_files.filter((f) => sensitive(f.path)).map((f) => project(f.path)));
  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const [a, b] = [contracts[i], contracts[j]];
      if (ancestors.get(a.id).has(b.id) || ancestors.get(b.id).has(a.id)) continue;
      const pathsA = new Set(a.allowed_files.map((f) => f.path));
      const shared = b.allowed_files.map((f) => f.path).filter((p) => pathsA.has(p));
      const sa = sensitiveProjects(a);
      const sharedSensitive = [...sensitiveProjects(b)].filter((p) => sa.has(p));
      if (shared.length || sharedSensitive.length)
        errors.push(`${a.id} and ${b.id} both touch ${[...shared, ...sharedSensitive.map((p) => `${p} ordering paths (lockfile, migrations, API contract)`)].join(', ')} — order them with depends_on`);
    }
  }
  return errors;
}

// `cd app && npm test`, `npm --prefix api run check` → the package.json scripts they need.
export function npmScriptsReferenced(cmd) {
  const found = [];
  let dir = '.';
  for (const part of cmd.split(/\s*&&\s*/)) {
    const cd = part.match(/^cd\s+(\S+)$/);
    if (cd) { dir = normalize(join(dir, cd[1])); continue; }
    const m = part.match(/^npm\s+(?:--prefix\s+(\S+)\s+)?(?:run\s+([\w:.-]+)|(test)\b)/);
    if (m) found.push({ dir: m[1] ? normalize(join(dir, m[1])) : dir, script: m[2] ?? m[3] });
  }
  return found;
}

// Everything that differs from the main commit the branch is based on must be in the allowlist.
export function outOfScope(changed, allowed) {
  const ok = new Set(allowed.map((f) => f.path));
  return changed.filter((p) => !ok.has(p));
}

// ---------------------------------------------------------------------------------------------------------------
// Findings flow from checks / e2e / review / CI back to the coder. A fingerprint seen in two consecutive rounds
// means the pair is going in circles, which is a replan, not another round.

export const fingerprint = (f) => `${f.source}:${f.key}`;
export function repeated(previous = [], current = []) {
  const prev = new Set(previous);
  return current.filter((f) => prev.has(f));
}
// Deterministic failures are keyed by their output (digits blanked, so timings don't matter): the same check failing
// with different output means the coder is moving, identical output twice means it isn't.
export const outputKey = (text = '') => createHash('sha1').update(text.replace(/\d+/g, '0')).digest('hex').slice(0, 8);

// Review convergence. The reviewer marks each previous blocking finding fixed / partial / not_fixed. Partial is
// progress and resets the count; not_fixed in two consecutive reviews is no progress, which is a replan. A finding
// the reviewer didn't mention stays open as partial. max_rounds remains the hard backstop.
export function reviewProgress(prior = [], statuses = [], strikes = {}) {
  const byIndex = new Map(statuses.map((s) => [s.index, s]));
  const open = [], stuck = [], next = {};
  prior.forEach((f, i) => {
    const s = byIndex.get(i + 1) ?? { status: 'partial' };
    if (s.status === 'fixed') return;
    next[f.id] = s.status === 'not_fixed' ? (strikes[f.id] ?? 0) + 1 : 0;
    (next[f.id] >= 2 ? stuck : open).push({ ...f, note: s.note });
  });
  return { open, stuck, strikes: next };
}

export function formatFindings(findings) {
  return findings.map((f, i) => {
    const where = f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    const fix = (f.fix ? `\n   fix: ${f.fix}` : '') + (f.note ? `\n   reviewer, last round: ${f.note}` : '');
    const out = f.output ? `\n   output (tail):\n${f.output.split('\n').map((l) => `     ${l}`).join('\n')}` : '';
    return `${i + 1}. [${f.source}${f.severity ? `/${f.severity}` : ''}] ${f.problem}${where}${fix}${out}`;
  }).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Locks for machine-wide resources (devices, fixed ports, a shared test database). A lock whose holder process
// is gone is stale and gets taken over, so a crashed driver can't wedge the run.

const lockDir = (name) => join(LOOPS, '.locks', name);
export async function acquireLock(name, holder, timeoutMin = 120) {
  const dir = lockDir(name);
  mkdirSync(dirname(dir), { recursive: true });
  const end = Date.now() + timeoutMin * 60_000;
  for (;;) {
    try {
      mkdirSync(dir);
      writeJson(join(dir, 'holder.json'), { holder, token: TOKEN, proc: identify(process.pid), since: now() });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = readJson(join(dir, 'holder.json'), null);
      if (owner && !isRunning(owner.proc)) { rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() > end) throw new Error(`lock ${name} timeout, held by ${owner?.holder}`);
      await sleep(10_000);
    }
  }
}
export function releaseLock(name, holder) {
  const owner = readJson(join(lockDir(name), 'holder.json'), null);
  if (owner?.holder === holder && owner.token === TOKEN) rmSync(lockDir(name), { recursive: true, force: true });
}
export async function withLocks(names, holder, fn) {
  const taken = [];
  try {
    for (const n of [...names].sort()) { await acquireLock(n, holder); taken.push(n); }
    return await fn();
  } finally {
    taken.forEach((n) => releaseLock(n, holder));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// `claude -p` with a role prompt and a JSON schema. `--agent` is not used: it drops structured output.

export const SCHEMAS = {
  coder: {
    type: 'object', additionalProperties: false, required: ['status', 'summary'],
    properties: {
      status: { enum: ['implemented', 'needs_replan', 'blocked'] },
      summary: { type: 'string', description: 'what changed, or why not' },
      reason: { type: 'string', description: 'needs_replan / blocked reason' },
    },
  },
  reviewer: {
    type: 'object', additionalProperties: false, required: ['verdict', 'previous', 'blocking', 'non_blocking', 'acceptance'],
    properties: {
      verdict: { enum: ['approve', 'changes_requested', 'needs_replan'] },
      previous: {
        type: 'array', description: 'one entry per previous blocking finding (by its number); empty in round 1',
        items: { type: 'object', additionalProperties: false, required: ['index', 'status'], properties: { index: { type: 'integer' }, status: { enum: ['fixed', 'partial', 'not_fixed'] }, note: { type: 'string', description: 'what is still missing' } } },
      },
      reason: { type: 'string', description: 'needs_replan reason' },
      blocking: { type: 'array', description: 'NEW blocker/major findings only; previous ones go in previous', items: { $ref: '#/$defs/finding' } },
      non_blocking: { type: 'array', items: { $ref: '#/$defs/finding' } },
      acceptance: {
        type: 'array', description: 'judgment ACs from the contract prose (not the command checks)',
        items: { type: 'object', additionalProperties: false, required: ['id', 'result', 'evidence'], properties: { id: { type: 'string' }, result: { enum: ['pass', 'fail'] }, evidence: { type: 'string' } } },
      },
    },
    $defs: {
      finding: {
        type: 'object', additionalProperties: false, required: ['severity', 'category', 'file', 'problem', 'fix'],
        properties: {
          severity: { enum: ['blocker', 'major', 'minor', 'nit'] }, category: { type: 'string' },
          file: { type: 'string' }, line: { type: 'integer' }, problem: { type: 'string' }, fix: { type: 'string' },
        },
      },
    },
  },
  triage: {
    type: 'object', additionalProperties: false, required: ['action', 'diagnosis'],
    properties: {
      action: { enum: ['retry', 'blocked', 'escalate'] },
      diagnosis: { type: 'string' },
      fixed: { type: 'string', description: 'what you changed in the environment, if anything' },
    },
  },
};
const GIT_WRITES = ['commit', 'push', 'reset', 'checkout', 'switch', 'rebase', 'merge', 'stash', 'clean', 'restore', 'worktree', 'branch', 'tag'];
export const ROLE_TOOLS = {
  coder: { tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], disallowed: [...GIT_WRITES.filter((c) => c !== 'restore').map((c) => `Bash(git ${c} *)`), 'Bash(gh *)'] },
  reviewer: { tools: ['Read', 'Bash', 'Grep', 'Glob'], disallowed: [...GIT_WRITES, 'add', 'rm', 'mv', 'apply'].map((c) => `Bash(git ${c} *)`).concat('Bash(gh *)') },
  triage: { tools: ['Read', 'Bash', 'Grep', 'Glob'], disallowed: [...GIT_WRITES, 'add', 'rm'].map((c) => `Bash(git ${c} *)`).concat('Bash(gh pr *)', 'Bash(gh issue *)') },
};

// OS sandbox for coder and reviewer (Claude Code `sandbox` settings, passed per call with --settings). Bash and
// everything it spawns may write only to the worktree, its git admin dir and caches, may not read credentials, and
// may reach only the configured domains (npm registry by default) and localhost. It fails closed: no unsandboxed
// fallback, and no run at all when the sandbox is unavailable. Read/Edit/Write are not sandboxed by the OS, so
// permission deny rules cover them: no secrets, and no edits to the main checkout, the crew's own files or home dotfiles.
const SECRETS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.npmrc', '.docker', '.kube'];

// The main checkout's top-level entries, minus the worktree directory, so the deny rules protect everything in the
// repo except the worktrees. Listed rather than globbed: gitignore-style `*` would also match the worktrees.
export function mainCheckoutEntries(root = ROOT, worktreeDir = CONFIG.worktree_dir) {
  const skip = new Set([worktreeDir.split('/')[0], '.git']);
  return readdirSync(root).filter((e) => !skip.has(e)).map((name) => ({ name, dir: statSync(join(root, name)).isDirectory() }));
}
// `.env*` files at the root and one level down, which the OS sandbox must not let Bash read.
export function envFiles(root = ROOT) {
  const found = [];
  for (const { name, dir } of mainCheckoutEntries(root)) {
    if (!dir && name.startsWith('.env')) found.push(join(root, name));
    if (dir && name !== 'node_modules') {
      try { for (const f of readdirSync(join(root, name))) if (f.startsWith('.env')) found.push(join(root, name, f)); } catch {}
    }
  }
  return found;
}

export function sandboxSettings(worktree) {
  const home = homedir();
  const gitDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir');
  const entries = mainCheckoutEntries();
  return {
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
      filesystem: {
        allowWrite: [worktree, gitDir, tmpdir(), '/tmp', '/private/tmp', join(home, '.npm'), join(home, '.cache'), join(home, 'Library/Caches'), ...CONFIG.sandbox.extra_write],
        denyRead: [...SECRETS.map((p) => join(home, p)), ...envFiles()],
      },
      network: { allowedDomains: CONFIG.sandbox.allowed_domains, allowLocalBinding: true, strictAllowlist: true },
    },
    permissions: {
      deny: [
        ...SECRETS.map((p) => `Read(~/${p}/**)`), ...SECRETS.map((p) => `Read(~/${p})`), `Read(/${ROOT}/.env*)`, `Read(/${ROOT}/*/.env*)`,
        ...entries.map((e) => (e.dir ? `Edit(/${ROOT}/${e.name}/**)` : `Edit(/${ROOT}/${e.name})`)), `Edit(/${ROOT}/.git/**)`,
        'Edit(~/.*)', 'Edit(~/.*/**)',
      ],
    },
  };
}

export function lastResult(logFile) {
  if (!existsSync(logFile)) return null;
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').reverse();
  for (const l of lines) {
    try { const m = JSON.parse(l); if (m.type === 'result') return m; } catch {}
  }
  return null;
}

// Prompt caching. The cache reuses only an identical prefix (tools → system prompt → messages), so:
// - the shared prefix moves the per-machine system-prompt sections (cwd, git status) into the first message, letting
//   every call of one role and model share the cached system prompt instead of each worktree writing its own;
// - the 1-hour TTL keeps that prefix, and a resumed coder's history, alive across checks, e2e and CI waits;
// - coder resume continues the task's coder session between rounds, so its context is read back, not rewritten.
// Measured 2026-11-05: a second call from another directory read 3.1k cached tokens instead of rewriting 4.7k, and a
// resumed call wrote 0.7k. Each switch can be turned off for a run with its env var set to 0.
const SHARED_PREFIX = process.env.CREW_SHARED_PREFIX !== '0';
const CACHE_1H = process.env.CREW_CACHE_1H !== '0';
export const CODER_RESUME = process.env.CREW_CODER_RESUME !== '0';

// Tokens of one `claude -p` call, all models included (modelUsage covers the whole call; `usage` only its last turn).
export function callUsage(result) {
  const sum = { input: 0, output: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0 };
  for (const m of Object.values(result?.modelUsage ?? {})) {
    sum.input += m.inputTokens ?? 0;
    sum.output += m.outputTokens ?? 0;
    sum.cache_write += m.cacheCreationInputTokens ?? 0;
    sum.cache_write_1h += m.cacheCreationEphemeral1hInputTokens ?? 0;
    sum.cache_read += m.cacheReadInputTokens ?? 0;
  }
  return sum;
}

// `cost.jsonl`: one line per `claude -p` call (coder, reviewer, triage), append-only, so replans and restarts never
// lose spend. `crew status` and `crew cost` read it.
const costFile = (run) => join(runDir(run), 'cost.jsonl');
export function recordCost(run, entry) {
  mkdirSync(runDir(run), { recursive: true });
  appendFileSync(costFile(run), JSON.stringify({ ts: now(), ...entry }) + '\n');
}
export function readCosts(run) {
  const file = costFile(run);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
// Totals per key (e.g. task, or task/role/model) for cost entries.
export function sumCosts(entries, keyOf) {
  const out = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    const t = out.get(k) ?? { calls: 0, cost: 0, input: 0, output: 0, cache_write: 0, cache_read: 0 };
    t.calls += 1;
    t.cost += e.cost ?? 0;
    for (const f of ['input', 'output', 'cache_write', 'cache_read']) t[f] += e.tokens?.[f] ?? 0;
    out.set(k, t);
  }
  return out;
}

// A resumed session reports cost and tokens for the whole session so far (measured 2026-11-05), so a call's own share
// is the difference from that session's last ledger entry.
export function callShare(total, prior) {
  if (!prior) return total;
  const tokens = Object.fromEntries(Object.entries(total.tokens).map(([k, v]) => [k, Math.max(0, v - (prior.tokens?.[k] ?? 0))]));
  return { cost: Math.max(0, total.cost - prior.cost), tokens };
}

export async function callClaude({ role, model, prompt, budget, timeoutMin, cwd, logFile, onSpawn, resume = null, ledger = null }) {
  if (resume && !ledger) throw new Error('a resumed call needs the ledger to separate its cost from the session total');
  const { tools, disallowed } = ROLE_TOOLS[role];
  const prior = resume ? readCosts(ledger.run).findLast((e) => e.session === resume)?.session_total ?? null : null;
  // The cap stays per call even if the CLI applies it to the session total.
  const cap = budget + (prior?.cost ?? 0);
  // --strict-mcp-config with no --mcp-config: no MCP servers, so the role sees only the tools listed here.
  const args = ['-p', '--model', model, '--permission-mode', 'auto', '--max-budget-usd', String(cap), '--strict-mcp-config',
    '--append-system-prompt-file', join(SKILL, 'prompts', `${role}.md`),
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(SCHEMAS[role]),
    '--tools', tools.join(','), '--disallowedTools', disallowed.join(','),
    ...(SHARED_PREFIX ? ['--exclude-dynamic-system-prompt-sections'] : []),
    ...(resume ? ['--resume', resume] : []),
    ...(role === 'triage' ? [] : ['--settings', JSON.stringify(sandboxSettings(cwd))])];
  const env = CACHE_1H ? { ENABLE_PROMPT_CACHING_1H: '1' } : undefined;
  const r = await run('claude', args, { cwd, input: prompt, logFile, timeoutMin, onSpawn, env });
  const result = lastResult(logFile);
  const output = result?.structured_output ?? null;
  const total = { cost: result?.total_cost_usd ?? 0, tokens: callUsage(result) };
  const { cost, tokens } = callShare(total, prior);
  if (ledger) recordCost(ledger.run, { ...ledger, role, model, resumed: Boolean(resume), session: result?.session_id ?? null, cost, tokens, session_total: total });
  return {
    ok: Boolean(output) && !result.is_error,
    output,
    cost,
    session: result?.session_id ?? null,
    failure: output ? null : r.timedOut ? 'timeout' : result?.subtype && result.subtype !== 'success' ? result.subtype : 'no structured output',
  };
}

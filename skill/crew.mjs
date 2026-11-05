#!/usr/bin/env node
// Crew CLI, used by the boss (and by people watching a run). Run from anywhere in the project:
//   node .claude/skills/crew/crew.mjs <command> [run] [...]
//
//   doctor                              check the machine, the repo and .claude/crew.config.json
//   issues [--json] [--check]           every issue from the project's tracker, read deterministically
//   validate <run>                      contract + batch checks; must pass before start
//   start <run> [batch...]              mark the run's issues in progress, launch an orchestrator per batch
//   status <run>                        task table: state, phase, round, cost, liveness
//   follow <run> [type,type...]         stream new events, one line each (for the Monitor tool)
//   event <run> <type> <task> [json]    append a boss event (retry, replanned, abandoned, blocked, …)
//   merge-check <run> <task>            deterministic merge eligibility; exit 0 when eligible, 3 when it needs a sync
//   merge <run> <task>                  re-check, squash-merge into the base branch with the report, update the issue
//   wrapup <run>                        apply merged contracts' docs edits, run the docs check, commit
//   watch <run> <task>                  follow a driver live (driver log + the current coder/reviewer call)
//   cost <run>                          spend per task, role and model from cost.jsonl, with cache reads vs writes
//   stop <run>                          stop orchestrators and drivers; nothing is merged
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import {
  CONFIG_FILE, DONE_FOR_DEPENDANTS, ROOT, SKILL, appendEvent, cfg, contractPath, git, isRunning, killGroup, lastStatus, loadBatch,
  npmScriptsReferenced, orderingErrors, readCosts, readEvents, readJson, runDir, shapeErrors, shell, sleep, sumCosts, tryGit, withDefaults, withTrailer, worktreeOf,
} from './lib.mjs';
import { issueErrors, issueTracker } from './issues.mjs';

const [cmd, ...args] = process.argv.slice(2);
const NO_RUN = new Set(['doctor', 'issues']);
const run = NO_RUN.has(cmd) ? null : args[0];
const rest = NO_RUN.has(cmd) ? args : args.slice(1);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const usage = () => { const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n'); return lines.slice(1, lines.findIndex((l) => l.startsWith('import'))).join('\n'); };
if (!cmd || (!run && !NO_RUN.has(cmd))) die(usage(), 2);

const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []);
const batchIds = () => listJson(join(runDir(run), 'batches'));
const taskIds = () => listJson(join(runDir(run), 'contracts'));
const contract = (id) => withDefaults(readJson(contractPath(run, id)));
const atBase = (path) => tryGit(ROOT, 'cat-file', '-e', `${cfg().baseBranch}:${path}`).ok;
// Raw file content on the base branch: not trimmed, so anchors that end with a newline still match.
const showBase = (path) => {
  try { return { ok: true, out: execFileSync('git', ['-C', ROOT, 'show', `${cfg().baseBranch}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }; } catch { return { ok: false, out: '' }; }
};
const state = (events, id) => lastStatus(events, id)?.type ?? 'none';
const tracker = () => issueTracker(ROOT, cfg().issues);
// Files that hold the issues: tasks may never edit them (the crew updates them at merge time).
const issuePaths = () => [cfg().issues.file, cfg().issues.adapter].filter(Boolean);

async function validate() {
  const config = cfg();
  const errors = [];
  const batches = Object.fromEntries(batchIds().map((b) => [b, loadBatch(run, b)]));
  const ids = taskIds();
  if (!ids.length) errors.push('no contracts/*.json');
  const issues = await (await tracker()).list();
  const issueIds = new Set(issues.map((i) => i.id));
  const contracts = [];
  for (const id of ids) {
    const c = contract(id);
    contracts.push(c);
    const b = batches[c.batch];
    errors.push(...shapeErrors(c, { dryRun: b?.dry_run, branchPrefix: config.branchPrefix, lockNames: Object.keys(config.locks) }));
    if (c.id !== id) errors.push(`${id}: id field is ${c.id}`);
    if (!existsSync(contractPath(run, id, 'md'))) errors.push(`${id}: prose contract ${id}.md missing`);
    if (!b) errors.push(`${id}: batch ${c.batch} has no batches/${c.batch}.json`);
    else if (!b.tasks?.includes(id)) errors.push(`${id}: not listed in batches/${c.batch}.json`);
    if (!b?.dry_run && c.issue != null && !issueIds.has(String(c.issue))) errors.push(`${id}: issue ${c.issue} is not in the issue tracker`);
    for (const dep of c.depends_on) if (!ids.includes(dep)) errors.push(`${id}: depends_on ${dep} is not in this run`);
    const allowed = new Map((c.allowed_files ?? []).map((f) => [f.path, f.op]));
    for (const [path, op] of allowed) {
      if (op !== 'create' && !atBase(path)) errors.push(`${id}: ${op} ${path}, but it does not exist on ${config.baseBranch}`);
      if (op === 'create' && atBase(path)) errors.push(`${id}: create ${path}, but it already exists on ${config.baseBranch}`);
      if (issuePaths().some((p) => path === p || path.startsWith(`${p}/`))) errors.push(`${id}: ${path} holds the issues; the crew updates it, tasks may not`);
      if (path.startsWith(`${config.stateDir}/`) || path.startsWith('.claude/skills/crew/')) errors.push(`${id}: ${path} belongs to the crew`);
    }
    for (const command of [...c.setup, ...c.gates, ...c.checks.map((ch) => ch.cmd)]) {
      for (const { dir, script } of npmScriptsReferenced(command)) {
        const pkg = dir === '.' ? 'package.json' : `${dir}/package.json`;
        if (allowed.has(pkg)) continue;
        const shown = showBase(pkg);
        const scripts = shown.ok ? JSON.parse(shown.out).scripts ?? {} : null;
        if (!scripts) errors.push(`${id}: \`${command}\` needs ${pkg}, missing on ${config.baseBranch}`);
        else if (!(script in scripts)) errors.push(`${id}: \`${command}\` runs npm script "${script}", not in ${pkg}`);
      }
    }
    for (const d of c.docs) {
      const shown = showBase(d.file);
      const count = shown.ok ? shown.out.split(d.find).length - 1 : 0;
      if (count !== 1) errors.push(`${id}: docs find text occurs ${count}× in ${d.file} (needs exactly 1): "${d.find.slice(0, 60)}"`);
    }
  }
  for (const [b, batch] of Object.entries(batches)) {
    for (const t of batch.tasks ?? []) if (!ids.includes(t)) errors.push(`batch ${b}: task ${t} has no contract`);
    if (!Number.isInteger(batch.max_parallel) || batch.max_parallel < 1) errors.push(`batch ${b}: max_parallel must be ≥ 1`);
  }
  const branches = contracts.map((c) => c.branch);
  if (new Set(branches).size !== branches.length) errors.push('two contracts share a branch');
  if (contracts.every((c) => Array.isArray(c.allowed_files))) errors.push(...orderingErrors(contracts, config.sensitivePaths));
  return errors;
}

// Not errors, but worth a second look: the same model reviewing its own kind of output makes correlated mistakes.
function warnings() {
  const rank = { haiku: 0, sonnet: 1, opus: 2 };
  const security = new RegExp(cfg().securityPaths, 'i');
  return taskIds().map(contract).flatMap((c) => {
    const [coder, reviewer] = [rank[c.models?.coder], rank[c.models?.reviewer]];
    if (reviewer < coder) return [`${c.id}: reviewer (${c.models.reviewer}) is weaker than the coder (${c.models.coder})`];
    if (reviewer === coder) return [`${c.id}: coder and reviewer are both ${c.models.coder}; use a stronger reviewer for security, auth or data work`];
    // An Opus review is usually the most expensive call in a run; the default reviewer is Sonnet.
    if (c.models.reviewer === 'opus' && !c.allowed_files.some((f) => security.test(f.path))) return [`${c.id}: opus reviewer on files that don't look security, auth or data shaped (securityPaths); sonnet is the default`];
    return [];
  });
}

const trailer = (id) => `Crew-Task: ${run}/${id}`;
const mergedCommit = (id) => git(ROOT, 'log', cfg().baseBranch, '-1', '--format=%H', `--grep=^${trailer(id)}$`) || null;

function mergeCheck(id) {
  const { baseBranch: base } = cfg();
  const events = readEvents(run);
  const c = contract(id);
  const last = lastStatus(events, id);
  if (last?.type !== 'ready_to_merge') return { eligible: false, reasons: [`state is ${last?.type ?? 'none'}, not ready_to_merge`] };
  const { head, dry_run: dry } = last.data;
  if (dry) return { eligible: false, reasons: ['rehearsal (dry run): never merged'] };
  // A crash after the squash commit but before the event: finish recording instead of merging twice.
  const already = mergedCommit(id);
  if (already) return { eligible: true, alreadyMerged: already, reasons: [], head, keepOpen: last.data.keep_open };
  const reasons = [];
  for (const dep of c.depends_on) if (!DONE_FOR_DEPENDANTS.has(state(events, dep))) reasons.push(`dependency ${dep} is ${state(events, dep)}`);
  const tip = tryGit(ROOT, 'rev-parse', '--verify', `refs/heads/${c.branch}`);
  if (!tip.ok) return { eligible: false, reasons: [...reasons, `branch ${c.branch} is missing`] };
  if (tip.out !== head) reasons.push(`branch tip ${tip.out.slice(0, 7)} ≠ approved head ${head.slice(0, 7)}`);
  const current = tryGit(ROOT, 'symbolic-ref', '--short', 'HEAD').out;
  if (current !== base) reasons.push(`the main folder is on "${current}"; check out ${base} there to merge`);
  if (!tryGit(ROOT, 'diff', '--cached', '--quiet').ok) reasons.push('the main folder has staged changes; commit or unstage them first');
  const changed = new Set(git(ROOT, 'diff', '--name-only', `${base}...${c.branch}`).split('\n').filter(Boolean));
  const dirty = git(ROOT, 'diff', '--name-only').split('\n').filter((p) => changed.has(p));
  if (dirty.length) reasons.push(`uncommitted local edits to files this task changes: ${dirty.join(', ')}`);
  // The driver merged the base into the branch and re-ran every check; if the base moved since, that must happen again.
  const needsSync = !tryGit(ROOT, 'merge-base', '--is-ancestor', base, head).ok;
  if (needsSync) reasons.push(`${base} moved since the branch was checked`);
  return { eligible: reasons.length === 0, reasons, needsSync, head, keepOpen: last.data.keep_open };
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);
function placeholders(id, events) {
  const last = lastStatus(events, id);
  const status = readJson(join(runDir(run), 'drivers', `${id}.json`), {});
  const evidence = (status.checks ?? []).map((r) => `${r.id} exit ${r.code}`).join(', ');
  return { merge: last?.data?.merge?.slice(0, 7) ?? '', evidence, issue: String(contract(id).issue), task: id };
}

const commands = {
  async doctor() {
    const lines = [];
    const ok = (good, text) => lines.push(`${good ? '✓' : '✗'} ${text}`);
    const [major] = process.versions.node.split('.').map(Number);
    ok(major >= 22, `node ${process.versions.node} (needs 22+)`);
    ok(true, `git repo at ${ROOT}`);
    const claude = await shell('claude --version', { logFile: join(ROOT, '.git', 'crew-doctor.log'), timeoutMin: 1 });
    ok(claude.code === 0, `claude CLI ${claude.out.split('\n')[0]}`);
    if (!existsSync(CONFIG_FILE)) { ok(false, `${relative(ROOT, CONFIG_FILE)} missing: run "/crew adapt"`); return console.log(lines.join('\n')); }
    const config = cfg();
    ok(true, `config ${relative(ROOT, CONFIG_FILE)}`);
    ok(tryGit(ROOT, 'rev-parse', '--verify', `refs/heads/${config.baseBranch}`).ok, `base branch ${config.baseBranch} exists`);
    const current = tryGit(ROOT, 'symbolic-ref', '--short', 'HEAD').out;
    ok(current === config.baseBranch, `main folder is on ${current} (merges need ${config.baseBranch})`);
    for (const dir of [`${config.stateDir}/runs`, `${config.stateDir}/locks`, config.worktreeDir]) ok(tryGit(ROOT, 'check-ignore', '-q', `${dir}/x`).ok, `${dir}/ is gitignored`);
    try {
      const t = await tracker();
      const list = await t.list();
      const errs = issueErrors(list);
      ok(errs.length === 0, `issues: ${list.length} from ${t.kind}${errs.length ? ` (${errs.length} problems: run "crew issues --check")` : ''}`);
    } catch (e) { ok(false, `issues: ${e.message}`); }
    for (const [name, what] of Object.entries(config.locks)) lines.push(`· lock ${name}: ${what}`);
    console.log(lines.join('\n'));
    if (lines.some((l) => l.startsWith('✗'))) process.exit(1);
  },

  async issues() {
    const t = await tracker();
    const list = await t.list();
    if (rest.includes('--check')) {
      const errs = issueErrors(list);
      if (errs.length) die(`✗ ${errs.length} problem(s) in ${t.kind}:\n${errs.map((e) => `- ${e}`).join('\n')}`);
      return console.log(`✓ ${list.length} issues from ${t.kind}`);
    }
    if (rest.includes('--json')) return console.log(JSON.stringify(list, null, 2));
    for (const i of list) console.log(`${i.id.padEnd(12)} ${i.status.padEnd(11)} ${i.priority ?? ''}\t${i.title}${i.depends_on.length ? `  (after ${i.depends_on.join(', ')})` : ''}`);
  },

  async validate() {
    const errors = await validate();
    if (errors.length) die(`✗ ${errors.length} problem(s):\n${errors.map((e) => `- ${e}`).join('\n')}`);
    console.log(`✓ ${taskIds().length} contracts in ${batchIds().length} batch(es) valid`);
    warnings().forEach((w) => console.log(`! ${w}`));
  },

  async start() {
    const errors = await validate();
    if (errors.length) die(`refusing to start, run validate:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    const t = await tracker();
    for (const id of taskIds()) {
      const c = contract(id);
      if (c.issue == null || loadBatch(run, c.batch).dry_run) continue;
      const issue = (await t.list()).find((i) => i.id === String(c.issue));
      if (issue && issue.status === 'open') await t.update(c.issue, { status: 'in_progress', note: `crew run ${run}: ${id} started` });
    }
    for (const b of rest.length ? rest : batchIds()) {
      const orch = readJson(join(runDir(run), `orch-${b}.json`), {});
      if (isRunning(orch.proc)) { console.log(`${b}: orchestrator already running (pid ${orch.proc.pid})`); continue; }
      mkdirSync(join(runDir(run), 'logs'), { recursive: true });
      const logFile = join(runDir(run), 'logs', `orch-${b}.log`);
      const fd = openSync(logFile, 'a');
      const child = spawn(process.execPath, [join(SKILL, 'orchestrator.mjs'), run, b], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd);
      child.unref();
      console.log(`${b}: orchestrator pid ${child.pid}, log ${relative(ROOT, logFile)}`);
    }
  },

  status() {
    const events = readEvents(run);
    // The ledger includes triage and survives replans; runs from before it fall back to each driver's own total.
    const spent = sumCosts(readCosts(run), (e) => e.task);
    const costOf = (id) => spent.get(id)?.cost ?? readJson(join(runDir(run), 'drivers', `${id}.json`), {}).cost ?? null;
    const rows = [['task', 'issue', 'batch', 'state', 'phase', 'round', 'cost $', 'driver', 'updated']];
    for (const id of taskIds()) {
      const c = contract(id);
      const s = readJson(join(runDir(run), 'drivers', `${id}.json`), {});
      const cost = costOf(id);
      rows.push([id, String(c.issue ?? '-'), c.batch, state(events, id), s.phase ?? '-', String(s.round ?? '-'), cost != null ? cost.toFixed(2) : '-', isRunning(s.proc) ? `pid ${s.proc.pid}` : '-', s.updated ?? '-']);
    }
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    rows.forEach((r) => console.log(r.map((v, i) => v.padEnd(widths[i])).join('  ')));
    const total = taskIds().reduce((sum, id) => sum + (costOf(id) ?? 0), 0);
    console.log(`total $${total.toFixed(2)}`);
    for (const b of batchIds()) {
      const o = readJson(join(runDir(run), `orch-${b}.json`), {});
      console.log(`orchestrator ${b}: ${isRunning(o.proc) ? `running pid ${o.proc.pid}` : 'not running'}`);
    }
  },

  async follow() {
    const types = rest[0] ? new Set(rest[0].split(',')) : null;
    let seen = readEvents(run).length;
    for (;;) {
      const events = readEvents(run);
      for (const e of events.slice(seen)) if (!types || types.has(e.type)) console.log(`${e.ts} ${e.type} ${e.task} ${JSON.stringify(e.data)}`);
      seen = events.length;
      await sleep(2000);
    }
  },

  event() {
    const [type, task, json] = rest;
    if (!type || !task) die('usage: event <run> <type> <task> [json-data]', 2);
    appendEvent(run, type, task, json ? JSON.parse(json) : {}, 'boss');
    console.log(`${task}: ${type}`);
  },

  'merge-check'() {
    const r = mergeCheck(rest[0]);
    console.log(r.eligible ? `✓ ${rest[0]} eligible @ ${r.head.slice(0, 7)}${r.alreadyMerged ? ' (already merged; merge will record it)' : ''}` : `✗ ${rest[0]} not eligible:\n${r.reasons.map((x) => `- ${x}`).join('\n')}`);
    process.exit(r.eligible ? 0 : r.needsSync ? 3 : 1);
  },

  async merge() {
    const id = rest[0];
    const c = contract(id);
    const r = mergeCheck(id);
    if (r.needsSync && r.reasons.length === 1) {
      appendEvent(run, 'rebase_needed', id, { reasons: r.reasons }, 'boss');
      die(`${id}: ${cfg().baseBranch} moved → rebase_needed (the orchestrator relaunches its driver to merge it in and re-check)`, 3);
    }
    if (!r.eligible) die(`✗ not eligible, nothing merged:\n${r.reasons.map((x) => `- ${x}`).join('\n')}`);
    let sha = r.alreadyMerged;
    const t = await tracker();
    if (!sha) {
      git(ROOT, 'merge', '--squash', c.branch);
      const note = c.keep_open
        ? `crew run ${run}: ${id} merged; stays open${c.manual_acceptance ? ` for manual acceptance: ${c.manual_acceptance}` : ''}`
        : `crew run ${run}: ${id} merged`;
      const changed = c.issue != null ? await t.update(c.issue, { status: c.keep_open ? 'in_progress' : 'done', note }) : null;
      if (changed) git(ROOT, 'add', '--', changed);
      const reportFile = join(runDir(run), 'reports', `${id}.md`);
      const body = existsSync(reportFile) ? readFileSync(reportFile, 'utf8').split('\n').slice(2).join('\n').trim() : c.summary;
      const message = join(runDir(run), 'reports', `${id}.commit.txt`);
      writeFileSync(message, `${withTrailer(`${c.commit}\n\n${body}\n\n${trailer(id)}`)}\n`);
      git(ROOT, 'commit', '-q', '-F', message);
      sha = git(ROOT, 'rev-parse', 'HEAD');
    }
    appendEvent(run, c.keep_open ? 'needs_human' : 'merged', id, { merge: sha }, 'boss');
    tryGit(ROOT, 'worktree', 'remove', worktreeOf(id));
    tryGit(ROOT, 'branch', '-D', c.branch);
    console.log(`✓ ${id}: merged into ${cfg().baseBranch} as ${sha.slice(0, 7)}${c.keep_open ? ` (issue ${c.issue} stays open: needs_human)` : c.issue != null ? ` (issue ${c.issue} done)` : ''}`);
  },

  async wrapup() {
    const config = cfg();
    const events = readEvents(run);
    const done = taskIds().filter((id) => DONE_FOR_DEPENDANTS.has(state(events, id)));
    if (git(ROOT, 'log', config.baseBranch, '-1', '--format=%H', `--grep=^Crew-Wrapup: ${run}$`)) return console.log(`wrapup for ${run} is already committed`);
    const edits = done.flatMap((id) => contract(id).docs.map((d) => ({ id, ...d })));
    if (!edits.length) return console.log('no docs edits in this run');
    const files = [...new Set(edits.map((e) => e.file))];
    if (tryGit(ROOT, 'symbolic-ref', '--short', 'HEAD').out !== config.baseBranch) die(`check out ${config.baseBranch} in the main folder first`);
    const dirty = git(ROOT, 'status', '--porcelain', '--', ...files);
    if (dirty) die(`these docs have uncommitted edits; commit or stash them first:\n${dirty}`);
    const failures = [];
    for (const e of edits) {
      const file = join(ROOT, e.file);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const count = text.split(e.find).length - 1;
      if (count !== 1) { failures.push(`${e.id}: "${e.find.slice(0, 60)}" occurs ${count}× in ${e.file}`); continue; }
      writeFileSync(file, text.replace(e.find, () => fill(e.replace, placeholders(e.id, events))));
    }
    if (failures.length) die(`applied what matched; fix these by hand, then commit:\n${failures.map((f) => `- ${f}`).join('\n')}`);
    if (config.docsCheck) {
      const check = await shell(config.docsCheck, { cwd: ROOT, logFile: join(runDir(run), 'logs', 'wrapup-docs-check.log') });
      if (check.code !== 0) die(`${config.docsCheck} failed (edits left uncommitted for you to fix):\n${check.out}`);
    }
    git(ROOT, 'add', '--', ...files);
    git(ROOT, 'commit', '-q', '-m', withTrailer(`docs: status for crew run ${run}\n\n${done.map((id) => `- ${id}`).join('\n')}\n\nCrew-Wrapup: ${run}`));
    console.log(`✓ docs committed on ${config.baseBranch} as ${git(ROOT, 'rev-parse', '--short', 'HEAD')}`);
  },

  async watch() {
    const id = rest[0];
    const dir = join(runDir(run), 'logs', id);
    const offsets = new Map();
    const show = (file, render) => {
      if (!existsSync(file)) return;
      const text = readFileSync(file, 'utf8');
      const from = offsets.get(file) ?? 0;
      offsets.set(file, text.length);
      text.slice(from).split('\n').filter(Boolean).forEach(render);
    };
    const renderCall = (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      for (const block of m.type === 'assistant' ? m.message?.content ?? [] : []) {
        if (block.type === 'text') console.log(`  ${block.text.slice(0, 300)}`);
        if (block.type === 'tool_use') console.log(`  → ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
      }
      if (m.type === 'result') console.log(`  = ${m.subtype} $${(m.total_cost_usd ?? 0).toFixed(2)} ${JSON.stringify(m.structured_output ?? '').slice(0, 300)}`);
    };
    for (;;) {
      show(join(dir, 'driver.log'), (l) => console.log(l));
      const calls = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs) : [];
      const current = calls.at(-1);
      if (current && !offsets.has(current)) console.log(`── ${current.split('/').pop()}`);
      if (current) show(current, renderCall);
      await sleep(1000);
    }
  },

  cost() {
    const entries = readCosts(run);
    if (!entries.length) die(`no cost.jsonl entries for ${run}`);
    const k = (n) => `${Math.round(n / 1000)}k`;
    // read share: how much of the prompt came from the cache rather than being written or sent fresh
    const hit = (t) => `${Math.round((100 * t.cache_read) / Math.max(1, t.cache_read + t.cache_write + t.input))}%`;
    const rows = [['task', 'role', 'model', 'calls', 'cost $', 'cache write', 'cache read', 'read share']];
    const add = (label, t) => rows.push([...label, String(t.calls), t.cost.toFixed(2), k(t.cache_write), k(t.cache_read), hit(t)]);
    for (const [key, t] of sumCosts(entries, (e) => `${e.task}\t${e.role}\t${e.model}`)) add(key.split('\t'), t);
    add(['total', '', ''], sumCosts(entries, () => 'all').get('all'));
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    rows.forEach((r) => console.log(r.map((v, i) => v.padEnd(widths[i])).join('  ')));
  },

  stop() {
    appendEvent(run, 'stop', '-', {}, 'boss');
    for (const b of batchIds()) killGroup(readJson(join(runDir(run), `orch-${b}.json`), {}).proc);
    for (const id of taskIds()) {
      const s = readJson(join(runDir(run), 'drivers', `${id}.json`), {});
      killGroup(s.child);
      killGroup(s.proc);
    }
    console.log(`stopped ${run}: branches and worktrees stay, nothing merged`);
  },
};

if (!commands[cmd]) die(`unknown command ${cmd}`, 2);
try { await commands[cmd](); } catch (e) { die(`✗ ${e.stderr?.toString().trim() || e.message}`); }

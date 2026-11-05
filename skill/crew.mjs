#!/usr/bin/env node
// Crew CLI, used by the boss (and by people watching a run). Run from anywhere in the repo:
//   node .claude/skills/crew/crew.mjs <command> <run> [...]
//
//   validate <run>                      contract + batch checks; must pass before start
//   start <run> [batch...]              launch an orchestrator per batch (skips live ones)
//   status <run>                        task table: state, phase, round, PR, cost, liveness
//   follow <run> [type,type...]         stream new events, one line each (for the Monitor tool)
//   event <run> <type> <task> [json]    append a boss event (retry, replanned, abandoned, blocked, …)
//   merge-check <run> <task>            deterministic merge eligibility; exit 0 when eligible
//   merge <run> <task>                  re-check, squash-merge, issue comment, merged/needs_human, clean up
//   wrapup <run> [--publish]            apply every merged contract's docs edits on one branch, then PR
//   watch <run> <task>                  follow a driver live (driver log + the current coder/reviewer call)
//   cost <run>                          spend per task, role and model from cost.jsonl, with cache reads vs writes
//   stop <run>                          stop orchestrators and drivers; nothing is merged
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  CONFIG, DONE_FOR_DEPENDANTS, MAIN, ROOT, SKILL, commitMessage, withFooter, appendEvent, commentOnce, contractPath, gh, git, isRunning, killGroup, lastStatus, loadBatch,
  npmScriptsReferenced, orderingErrors, readCosts, readEvents, readJson, runDir, shapeErrors, shell, sleep, sumCosts, tryGit, withDefaults, worktreeOf,
} from './lib.mjs';

const [cmd, run, ...rest] = process.argv.slice(2);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!cmd || (!run && cmd !== 'help')) die(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n'), 2);

const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []);
const batchIds = () => listJson(join(runDir(run), 'batches'));
const taskIds = () => listJson(join(runDir(run), 'contracts'));
const contract = (id) => withDefaults(readJson(contractPath(run, id)));
const atMain = (path) => tryGit(ROOT, 'cat-file', '-e', `${MAIN}:${path}`).ok;
const showMain = (path) => tryGit(ROOT, 'show', `${MAIN}:${path}`);
const state = (events, id) => lastStatus(events, id)?.type ?? 'none';

function validate() {
  tryGit(ROOT, 'fetch', CONFIG.remote);
  const errors = [];
  const batches = Object.fromEntries(batchIds().map((b) => [b, loadBatch(run, b)]));
  const ids = taskIds();
  if (!ids.length) errors.push('no contracts/*.json');
  const contracts = [];
  for (const id of ids) {
    const raw = readJson(contractPath(run, id));
    const c = withDefaults(raw);
    contracts.push(c);
    const b = batches[c.batch];
    errors.push(...shapeErrors(c, { dryRun: b?.dry_run }));
    if (c.id !== id) errors.push(`${id}: id field is ${c.id}`);
    if (!existsSync(contractPath(run, id, 'md'))) errors.push(`${id}: prose contract ${id}.md missing`);
    if (!b) errors.push(`${id}: batch ${c.batch} has no batches/${c.batch}.json`);
    else if (!b.tasks?.includes(id)) errors.push(`${id}: not listed in batches/${c.batch}.json`);
    for (const dep of c.depends_on) if (!ids.includes(dep)) errors.push(`${id}: depends_on ${dep} is not in this run`);
    const allowed = new Map((c.allowed_files ?? []).map((f) => [f.path, f.op]));
    for (const [path, op] of allowed) {
      if (op !== 'create' && !atMain(path)) errors.push(`${id}: ${op} ${path}, but it does not exist on ${MAIN}`);
      if (op === 'create' && atMain(path)) errors.push(`${id}: create ${path}, but it already exists on ${MAIN}`);
    }
    for (const command of [...c.setup, ...c.gates, ...c.checks.map((ch) => ch.cmd), ...c.e2e.map((e) => e.cmd)]) {
      for (const { dir, script } of npmScriptsReferenced(command)) {
        const pkg = dir === '.' ? 'package.json' : `${dir}/package.json`;
        if (allowed.has(pkg)) continue;
        const shown = showMain(pkg);
        const scripts = shown.ok ? JSON.parse(shown.out).scripts ?? {} : null;
        if (!scripts) errors.push(`${id}: \`${command}\` needs ${pkg}, missing on ${MAIN}`);
        else if (!(script in scripts)) errors.push(`${id}: \`${command}\` runs npm script "${script}", not in ${pkg}`);
      }
    }
    for (const d of c.docs) {
      const shown = showMain(d.file);
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
  if (contracts.every((c) => Array.isArray(c.allowed_files))) errors.push(...orderingErrors(contracts));
  return errors;
}

const SECURITY_SHAPED = new RegExp(CONFIG.security_paths, 'i');

// Not errors, but worth a second look: the same model reviewing its own kind of output makes correlated mistakes.
function warnings() {
  const rank = { haiku: 0, sonnet: 1, opus: 2 };
  return taskIds().map(contract).flatMap((c) => {
    const [coder, reviewer] = [rank[c.models?.coder], rank[c.models?.reviewer]];
    if (reviewer < coder) return [`${c.id}: reviewer (${c.models.reviewer}) is weaker than the coder (${c.models.coder})`];
    if (reviewer === coder) return [`${c.id}: coder and reviewer are both ${c.models.coder}; use a stronger reviewer for security, auth or migration work`];
    // Opus reviews are the most expensive call in a run; the default is a Sonnet reviewer.
    if (c.models.reviewer === 'opus' && !c.allowed_files.some((f) => SECURITY_SHAPED.test(f.path))) return [`${c.id}: opus reviewer on files that don't look security, auth or migration shaped; sonnet is the default`];
    return [];
  });
}

function mergeCheck(id) {
  const events = readEvents(run);
  const c = contract(id);
  const reasons = [];
  const last = lastStatus(events, id);
  if (last?.type !== 'ready_to_merge') return { eligible: false, reasons: [`state is ${last?.type ?? 'none'}, not ready_to_merge`] };
  const { pr, head, dry_run: dry } = last.data;
  if (dry || !pr) return { eligible: false, reasons: ['dry run: there is no PR to merge'] };
  for (const dep of c.depends_on) if (!DONE_FOR_DEPENDANTS.has(state(events, dep))) reasons.push(`dependency ${dep} is ${state(events, dep)}`);
  const view = JSON.parse(gh('pr', 'view', String(pr), '--json', 'state,headRefOid,mergeable,mergeStateStatus,statusCheckRollup'));
  // Merged at the approved head but not recorded (a crash after `gh pr merge`): finish recording, don't refuse.
  if (view.state === 'MERGED' && view.headRefOid === head) return { eligible: true, alreadyMerged: true, reasons: [], pr, head, refsOnly: last.data.refs_only };
  if (view.state !== 'OPEN') reasons.push(`PR #${pr} is ${view.state}`);
  if (view.headRefOid !== head) reasons.push(`PR head ${view.headRefOid.slice(0, 7)} ≠ approved head ${head.slice(0, 7)}`);
  const checks = view.statusCheckRollup ?? [];
  if (!checks.length) reasons.push('no CI checks');
  const notGreen = checks.filter((ch) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(ch.conclusion ?? ch.state));
  if (notGreen.length) reasons.push(`checks not green: ${notGreen.map((ch) => `${ch.name ?? ch.context}=${ch.conclusion || ch.status || ch.state}`).join(', ')}`);
  const conflict = view.mergeable === 'CONFLICTING' || view.mergeStateStatus === 'BEHIND' || view.mergeStateStatus === 'DIRTY';
  if (conflict) reasons.push(`PR #${pr} needs main merged in (${view.mergeable}/${view.mergeStateStatus})`);
  else if (view.mergeable !== 'MERGEABLE') reasons.push(`mergeability is ${view.mergeable} (retry shortly)`);
  return { eligible: reasons.length === 0, reasons, conflict, pr, head, refsOnly: last.data.refs_only };
}

let url;
const repoUrl = () => (url ??= gh('repo', 'view', '--json', 'url', '-q', '.url'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);
function placeholders(id, events) {
  const merged = lastStatus(events, id);
  const status = readJson(join(runDir(run), 'drivers', `${id}.json`), {});
  const evidence = [...(status.checks ?? []).map((r) => `${r.id} exit ${r.code}`), ...(status.e2e ?? []).map((r) => `${r.id} exit ${r.code}`)].join(', ');
  const pr = merged?.data?.pr;
  return { pr: pr ? `[#${pr}](${repoUrl()}/pull/${pr})` : '', merge: merged?.data?.merge?.slice(0, 7) ?? '', evidence, issue: String(contract(id).issue) };
}

const commands = {
  validate() {
    const errors = validate();
    if (errors.length) die(`✗ ${errors.length} problem(s):\n${errors.map((e) => `- ${e}`).join('\n')}`);
    console.log(`✓ ${taskIds().length} contracts in ${batchIds().length} batch(es) valid`);
    warnings().forEach((w) => console.log(`! ${w}`));
  },

  start() {
    const errors = validate();
    if (errors.length) die(`refusing to start, run validate:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    for (const b of rest.length ? rest : batchIds()) {
      const orch = readJson(join(runDir(run), `orch-${b}.json`), {});
      if (isRunning(orch.proc)) { console.log(`${b}: orchestrator already running (pid ${orch.proc.pid})`); continue; }
      const logFile = join(runDir(run), 'logs', `orch-${b}.log`);
      mkdirSync(join(runDir(run), 'logs'), { recursive: true });
      const fd = openSync(logFile, 'a');
      const child = spawn(process.execPath, [join(SKILL, 'orchestrator.mjs'), run, b], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd);
      child.unref();
      console.log(`${b}: orchestrator pid ${child.pid}, log ${logFile}`);
    }
  },

  status() {
    const events = readEvents(run);
    const spent = sumCosts(readCosts(run), (e) => e.task); // includes triage; runs before the ledger fall back to the driver's total
    const rows = [['task', 'batch', 'state', 'phase', 'round', 'pr', 'cost $', 'driver', 'updated']];
    for (const id of taskIds()) {
      const c = contract(id);
      const s = readJson(join(runDir(run), 'drivers', `${id}.json`), {});
      const cost = spent.get(id)?.cost ?? s.cost;
      rows.push([id, c.batch, state(events, id), s.phase ?? '-', String(s.round ?? '-'), s.pr ? `#${s.pr}` : '-', cost != null ? cost.toFixed(2) : '-', isRunning(s.proc) ? `pid ${s.proc.pid}` : '-', s.updated ?? '-']);
    }
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    rows.forEach((r) => console.log(r.map((v, i) => v.padEnd(widths[i])).join('  ')));
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
    console.log(r.eligible ? `✓ ${rest[0]} eligible: PR #${r.pr} @ ${r.head.slice(0, 7)}` : `✗ ${rest[0]} not eligible:\n${r.reasons.map((x) => `- ${x}`).join('\n')}`);
    process.exit(r.eligible ? 0 : r.conflict ? 3 : 1);
  },

  merge() {
    const id = rest[0];
    const c = contract(id);
    const r = mergeCheck(id);
    if (r.conflict) {
      appendEvent(run, 'rebase_needed', id, { reasons: r.reasons }, 'boss');
      die(`${id}: conflicts with main → rebase_needed (the orchestrator relaunches its driver)`, 3);
    }
    if (!r.eligible) die(`✗ not eligible, nothing merged:\n${r.reasons.map((x) => `- ${x}`).join('\n')}`);
    if (!r.alreadyMerged) gh('pr', 'merge', String(r.pr), '--squash', '--match-head-commit', r.head);
    const merge = JSON.parse(gh('pr', 'view', String(r.pr), '--json', 'mergeCommit')).mergeCommit?.oid;
    const values = { pr: `#${r.pr}`, merge: merge?.slice(0, 7), issue: String(c.issue) };
    const comment = [c.issue_comment && fill(c.issue_comment, values), r.refsOnly && c.manual_acceptance && `Still open for manual acceptance: ${c.manual_acceptance}`].filter(Boolean).join('\n\n');
    if (comment) commentOnce(c.issue, `${run}:${id}:merged`, comment);
    appendEvent(run, r.refsOnly ? 'needs_human' : 'merged', id, { pr: r.pr, merge }, 'boss');
    tryGit(ROOT, 'push', CONFIG.remote, '--delete', c.branch);
    tryGit(ROOT, 'worktree', 'remove', worktreeOf(id));
    tryGit(ROOT, 'branch', '-D', c.branch);
    console.log(`✓ ${id}: PR #${r.pr} merged as ${merge?.slice(0, 7)}${r.refsOnly ? ' (issue left open: needs_human)' : ''}`);
  },

  async wrapup() {
    const events = readEvents(run);
    const done = taskIds().filter((id) => DONE_FOR_DEPENDANTS.has(state(events, id)));
    const branch = `${CONFIG.branch_prefix}crew-${run}-docs`;
    const wt = worktreeOf(`crew-${run}-docs`);
    // Every step checks what already happened, so a wrapup interrupted anywhere can simply be run again.
    git(ROOT, 'fetch', CONFIG.remote);
    if (!existsSync(wt)) {
      const exists = tryGit(ROOT, 'rev-parse', '--verify', `refs/heads/${branch}`).ok;
      git(ROOT, 'worktree', 'add', wt, ...(exists ? [branch] : ['-b', branch, MAIN]));
    }
    const committed = () => git(wt, 'log', '--oneline', `${MAIN}..HEAD`) !== '';
    if (!rest.includes('--publish') && !committed()) {
      const failures = [];
      for (const id of done) {
        const values = placeholders(id, events);
        for (const d of contract(id).docs) {
          const file = join(wt, d.file);
          const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
          const count = text.split(d.find).length - 1;
          if (count !== 1) { failures.push(`${id}: "${d.find.slice(0, 60)}" occurs ${count}× in ${d.file}`); continue; }
          writeFileSync(file, text.replace(d.find, () => fill(d.replace, values)));
        }
      }
      if (failures.length) die(`applied what matched in ${wt}; fix these by hand there, then run wrapup ${run} --publish:\n${failures.map((f) => `- ${f}`).join('\n')}`);
    }
    if (CONFIG.docs_check) {
      const check = await shell(CONFIG.docs_check, { cwd: wt, logFile: join(runDir(run), 'logs', 'wrapup-docs-check.log') });
      if (check.code !== 0) die(`${CONFIG.docs_check} failed in ${wt}:\n${check.out}`);
    }
    if (git(wt, 'status', '--porcelain')) {
      git(wt, 'add', '-A');
      git(wt, 'commit', '-m', commitMessage(`docs: status for crew ${run}`));
    }
    if (!committed()) die('nothing to commit: no docs edits applied');
    git(wt, 'push', '-u', CONFIG.remote, branch);
    const open = JSON.parse(gh('pr', 'list', '--head', branch, '--state', 'open', '--json', 'url'));
    if (open.length) return console.log(open[0].url);
    const list = done.map((id) => `- ${id}: ${placeholders(id, events).pr}`).join('\n');
    const url = gh('pr', 'create', '--base', CONFIG.main_branch, '--head', branch, '--title', `docs: status for crew ${run}`, '--body',
      withFooter(`Status docs for the tasks merged in crew run \`${run}\`:\n\n${list}${CONFIG.docs_check ? `\n\n\`${CONFIG.docs_check}\` passes.` : ''}`));
    console.log(url);
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
    // cache read share: how much of the prompt came from the cache rather than being written or sent fresh
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
    console.log(`stopped ${run}: open PRs stay open, nothing merged`);
  },
};

if (!commands[cmd]) die(`unknown command ${cmd}`, 2);
try { await commands[cmd](); } catch (e) { die(`✗ ${e.stderr?.toString().trim() || e.message}`); }

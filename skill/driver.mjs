#!/usr/bin/env node
// Crew driver: the deterministic loop around one task's coder ↔ reviewer pair.
//   node driver.mjs <run> <PLAN-ID>
// prepare → [code → verify (scope, commit, checks, e2e) → review] × rounds → sync main → push + PR → CI → ready_to_merge
// Every step saves drivers/<id>.json first, so a killed driver relaunches where it stopped. The only judgment calls
// are the coder and reviewer (`claude -p`); routing between them is fixed here.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODER_RESUME, CONFIG, MAIN, ROOT, appendEvent, commitMessage, withFooter, callClaude, commentOnce, contractPath, fingerprint, formatFindings, gh, git, identify, killGroup, loadContract, log, now,
  outOfScope, outputKey, readEvents, readJson, repeated, reviewProgress, retry, runDir, shell, taskState, tryGit, withLocks, worktreeOf, writeJson,
} from './lib.mjs';

const [run, id] = process.argv.slice(2);
if (!run || !id) { console.error('usage: driver.mjs <run> <PLAN-ID>'); process.exit(2); }

const DRY = process.env.CREW_DRY === '1'; // no claim, push, PR or CI: stops at ready_to_merge with pr=null
const c = loadContract(run, id);
const wt = worktreeOf(id);
const logs = join(runDir(run), 'logs', id);
const statusFile = join(runDir(run), 'drivers', `${id}.json`);
const st = readJson(statusFile, { phase: 'prepare', round: 1, sync_rounds: 0, contract: c.version, cost: 0, findings: [], fingerprints: [] });
const SELF = identify(process.pid);
const save = (patch = {}) => writeJson(statusFile, Object.assign(st, patch, { updated: now(), proc: SELF }));
const emit = (type, data = {}) => appendEvent(run, type, id, data, 'driver');
const onSpawn = (pid) => save({ child: identify(pid) });
const ledger = () => ({ run, task: id, round: st.round, version: c.version });

setInterval(() => save(), 60_000).unref(); // heartbeat: the orchestrator treats a stale `updated` as a hung driver
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { killGroup(st.child); process.exit(143); });

class Stop extends Error {} // the driver handed the task to someone else (boss/orchestrator) and exits
// Event first: if the driver dies right after, the task state is already right and nothing is re-run.
function stop(type, data) { emit(type, data); save({ phase: type }); throw new Stop(type); }

// Relaunch after the boss acted: a new contract version restarts the rounds, a conflict goes back through sync.
const state = taskState(readEvents(run), id);
if (st.contract !== c.version) save({ contract: c.version, phase: existsSync(wt) ? 'code' : 'prepare', round: 1, findings: [], fingerprints: [], coder_session: null });
if (state === 'rebase_needed') save({ phase: 'sync', sync_rounds: 0 });
const HANDED_OFF = ['help', 'escalate', 'blocked', 'needs_replan'];
if (['retry', 'replanned'].includes(state) && HANDED_OFF.includes(st.phase)) save({ phase: st.resume_phase ?? 'code', coder_failures: 0, reviewer_failures: 0 });

const head = () => git(wt, 'rev-parse', 'HEAD');
const changedVsMain = () => [...new Set([
  ...git(wt, 'diff', '--name-only', st.main_sha).split('\n'),
  ...git(wt, 'ls-files', '--others', '--exclude-standard').split('\n'),
].filter(Boolean))];

function nextRound(findings, { counts = true } = {}) {
  // Review findings converge through reviewProgress; exact repeats only apply to deterministic failures.
  const prints = findings.filter((f) => f.source !== 'review').map(fingerprint);
  const again = repeated(st.fingerprints, prints);
  if (again.length) stop('needs_replan', { reason: `same findings two rounds in a row: ${again.join(', ')}`, findings });
  if (counts && st.round + 1 > c.max_rounds) stop('needs_replan', { reason: `${c.max_rounds} rounds without approval`, findings });
  save({ phase: 'code', round: counts ? st.round + 1 : st.round, findings, fingerprints: prints });
}

// A dead `claude -p` (timeout/crash) is retried once in place; budget overruns and repeats go upward.
function callFailed(role, failure) {
  if (/budget/i.test(failure)) stop('escalate', { reason: `${role} hit its $${c.budget_usd[role]} budget`, resume_phase: st.phase });
  const key = `${role}_failures`;
  if ((st[key] ?? 0) >= 1) { save({ resume_phase: st.phase }); stop('help', { reason: `${role} call failed twice: ${failure}`, log: logs }); }
  save({ [key]: (st[key] ?? 0) + 1 });
}

async function prepare() {
  await retry(() => git(ROOT, 'fetch', CONFIG.remote));
  // Drivers start side by side, and concurrent `git worktree add` calls collide on .git/config.lock: retry, re-checking.
  await retry(() => {
    if (existsSync(wt)) return;
    const branchExists = tryGit(ROOT, 'rev-parse', '--verify', `refs/heads/${c.branch}`).ok;
    git(ROOT, 'worktree', 'add', wt, ...(branchExists ? [c.branch] : ['-b', c.branch, MAIN]));
  }, 4, 2000 + Math.random() * 2000);
  save({ main_sha: st.main_sha ?? git(wt, 'merge-base', 'HEAD', MAIN) });
  if (!DRY && !st.claimed) {
    commentOnce(c.issue, `${run}:${id}:claim`, `Claimed by crew \`${run}\`: contract ${id} v${c.version}, branch \`${c.branch}\`.`);
    save({ claimed: true });
  }
  for (const [i, cmd] of c.setup.entries()) {
    if (st.setup_done?.includes(i)) continue;
    const r = await shell(cmd, { cwd: wt, logFile: join(logs, `setup-${i}.log`), timeoutMin: c.timeout_min.setup, onSpawn });
    if (r.code !== 0) { save({ resume_phase: 'prepare' }); stop('help', { reason: `setup failed: ${cmd} (exit ${r.code})`, output: r.out }); }
    save({ setup_done: [...(st.setup_done ?? []), i] });
  }
  save({ phase: 'code' });
}

async function code() {
  const repair = st.findings.length
    ? `\nRound ${st.round}. Fix exactly these findings, nothing else:\n${formatFindings(st.findings)}\n`
    : `\nRound 1: implement the contract's Execution steps.\n`;
  const prompt = `Contract (prose): ${contractPath(run, id, 'md')}
Contract (machine): ${contractPath(run, id)}
Worktree (your cwd): ${wt}
Allowed files: ${c.allowed_files.map((f) => `${f.path} (${f.op})`).join(', ')}
${repair}`;
  // The coder session continues across this contract version's rounds, so its context is a cache read. A replan
  // starts a fresh one, and so does the retry after a failed call.
  const resume = CODER_RESUME ? st.coder_session ?? null : null;
  log(`round ${st.round}: coder (${c.models.coder})${resume ? ' resumed' : ''}`);
  const r = await withLocks(c.locks.filter((l) => l !== 'e2e'), id, () => callClaude({
    role: 'coder', model: c.models.coder, prompt, budget: c.budget_usd.coder, timeoutMin: c.timeout_min.coder,
    cwd: wt, logFile: join(logs, `r${st.round}-coder.jsonl`), onSpawn, resume, ledger: ledger(),
  }));
  save({ cost: st.cost + r.cost, coder_session: r.ok ? r.session : null });
  if (!r.ok) return callFailed('coder', r.failure);
  const { status, summary, reason } = r.output;
  emit('round', { round: st.round, step: 'coder', status, summary });
  if (status === 'needs_replan') stop('needs_replan', { reason });
  // The coder's own checks run inside the sandbox and are only advisory. If it reports blocked but left changes,
  // the driver's checks (outside the sandbox) decide: green means the block was sandbox-only.
  if (status === 'blocked' && !changedVsMain().length) { save({ resume_phase: 'code' }); stop('help', { reason: `coder blocked: ${reason}` }); }
  save({ phase: 'verify', coder_blocked: status === 'blocked' ? reason : null });
}

async function verify() {
  // 1. Scope: the whole branch versus its main base, uncommitted work included.
  const changed = changedVsMain();
  const outside = outOfScope(changed, c.allowed_files);
  if (outside.length) return nextRound(outside.map((p) => ({ source: 'scope', key: p, file: p, problem: 'changed outside the allowlist', fix: 'revert this file, or return needs_replan if the contract really needs it' })));
  if (!changed.length) return nextRound([{ source: 'empty', key: 'no-diff', problem: 'the branch has no changes against main' }]);

  // 2. Commit whatever the coder left (or conclude a merge from sync).
  const dirty = git(wt, 'status', '--porcelain').length > 0;
  const merging = tryGit(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').ok;
  if (dirty || merging) {
    const conflictMarkers = tryGit(wt, 'diff', '--check');
    if (!conflictMarkers.ok) return nextRound([{ source: 'check', key: `diff-check#${outputKey(conflictMarkers.out)}`, problem: 'git diff --check failed (whitespace errors or conflict markers)', output: conflictMarkers.out }]);
    git(wt, 'add', '-A', '--', ...changed);
    const message = merging ? `Merge ${MAIN} into ${c.branch}` : st.round === 1 && !st.committed ? c.commit : `${c.commit.replace(/ \(.*\)$/, '')}: round ${st.round} fixes (${id})`;
    git(wt, 'commit', '-m', commitMessage(message));
    save({ committed: true, head: head() });
  }

  // 3. Commands with exit codes: acceptance checks, then gates.
  const results = [];
  await withLocks(c.locks.filter((l) => l !== 'e2e'), id, async () => {
    const all = [...c.checks.map((ch) => ({ ...ch })), ...c.gates.map((cmd, i) => ({ id: `gate${i + 1}`, cmd, expect_exit: 0 }))];
    for (const ch of all) {
      log(`check ${ch.id}: ${ch.cmd}`);
      const r = await shell(ch.cmd, { cwd: wt, logFile: join(logs, `r${st.round}-${ch.id}.log`), timeoutMin: c.timeout_min.checks, onSpawn });
      results.push({ id: ch.id, cmd: ch.cmd, code: r.code, ok: r.code === ch.expect_exit, out: r.out.split('\n').slice(-25).join('\n') });
    }
  });
  save({ checks: results.map(({ out, ...rest }) => rest) });
  const failed = results.filter((r) => !r.ok);
  if (failed.length && st.coder_blocked) { save({ resume_phase: 'code', coder_blocked: null }); stop('help', { reason: `coder blocked and checks fail outside the sandbox too: ${st.coder_blocked}`, failed: failed.map((r) => r.id) }); }
  if (st.coder_blocked) save({ coder_blocked: null });
  if (failed.length) return nextRound(failed.map((r) => ({ source: 'check', key: `${r.id}#${outputKey(r.out)}`, problem: `${r.id} \`${r.cmd}\` exited ${r.code}`, output: r.out })));

  // 4. End-to-end commands (devices, browsers, shared ports), one driver at a time on this machine.
  if (c.e2e.length) {
    const e2e = await withLocks(['e2e'], id, async () => {
      const out = [];
      for (const [i, e] of c.e2e.entries()) {
        log(`e2e ${e.id}: ${e.cmd}`);
        const r = await shell(e.cmd, { cwd: wt, env: { OUT: join(logs, `r${st.round}-e2e-${i}`) }, logFile: join(logs, `r${st.round}-e2e-${i}.log`), timeoutMin: c.timeout_min.e2e, onSpawn });
        out.push({ ...e, code: r.code, out: r.out.split('\n').slice(-20).join('\n') });
      }
      return out;
    });
    save({ e2e: e2e.map(({ out, ...rest }) => rest) });
    const bad = e2e.filter((r) => r.code !== 0);
    if (bad.length) return nextRound(bad.map((r) => ({ source: 'e2e', key: `${r.id}#${outputKey(r.out)}`, problem: `e2e ${r.id} \`${r.cmd}\` failed. If this is environment (build, device, browser, server) rather than the change, return blocked`, output: r.out })));
  }
  save({ phase: st.after_verify ?? 'review', after_verify: null });
}

async function review() {
  const base = st.main_sha;
  const checks = (st.checks ?? []).map((r) => `- ${r.id}: \`${r.cmd}\` → exit ${r.code} (${r.ok ? 'pass' : 'FAIL'})`).join('\n');
  const e2e = (st.e2e ?? []).map((r) => `- e2e ${r.id}: \`${r.cmd}\` → exit ${r.code}`).join('\n');
  const previous = st.prev_review?.length
    ? `\nRound ${st.round}. The previous blocking findings, numbered:\n${formatFindings(st.prev_review)}\nIn \`previous\`, mark each one fixed, partial (real progress, not done) or not_fixed (no meaningful change), with a note on what is missing. Put only NEW blocker/major problems in \`blocking\`, including any the fix introduced. No new nits.\n`
    : '';
  const prompt = `Contract (prose): ${contractPath(run, id, 'md')}
Contract (machine): ${contractPath(run, id)}
Worktree (your cwd): ${wt}
Diff to review: git diff ${base}..${head()}
Deterministic results (already passed, do not re-run them):
${checks || '- none'}
${e2e}
${previous}`;
  log(`round ${st.round}: reviewer (${c.models.reviewer})`);
  const before = head();
  const r = await callClaude({ role: 'reviewer', model: c.models.reviewer, prompt, budget: c.budget_usd.reviewer, timeoutMin: c.timeout_min.reviewer, cwd: wt, logFile: join(logs, `r${st.round}-reviewer.jsonl`), onSpawn, ledger: ledger() });
  save({ cost: st.cost + r.cost });
  if (head() !== before || git(wt, 'status', '--porcelain')) {
    git(wt, 'reset', '--hard', before); // the reviewer is read-only; undo anything it left
    git(wt, 'clean', '-fd');
  }
  if (!r.ok) return callFailed('reviewer', r.failure);
  const { verdict, previous: statuses, blocking, non_blocking, acceptance, reason } = r.output;
  const failedAcs = acceptance.filter((a) => a.result === 'fail');
  const progress = reviewProgress(st.prev_review, statuses, st.strikes);
  emit('round', { round: st.round, step: 'reviewer', verdict, open: progress.open.length, stuck: progress.stuck.length, new_blocking: blocking.length, failed_acs: failedAcs.length });
  if (verdict === 'needs_replan') stop('needs_replan', { reason });
  if (progress.stuck.length) stop('needs_replan', { reason: `no progress on ${progress.stuck.map((f) => f.id).join(', ')} in two consecutive reviews`, findings: progress.stuck });
  const review = [
    ...progress.open,
    ...blocking.map((f, i) => ({ source: 'review', id: `R${st.round}.${i + 1}`, key: `R${st.round}.${i + 1}`, ...f })),
  ];
  const acs = failedAcs.map((a) => ({ source: 'review', key: `ac:${a.id}:r${st.round}`, problem: `acceptance ${a.id} fails: ${a.evidence}` }));
  // The verdict follows the findings: anything open or new blocks, nothing open approves.
  if (review.length || acs.length) { save({ prev_review: review, strikes: progress.strikes }); return nextRound([...review, ...acs]); }
  save({ review: { acceptance, non_blocking, round: st.round }, phase: 'sync' });
}

async function sync() {
  await retry(() => git(wt, 'fetch', CONFIG.remote));
  const main = git(wt, 'rev-parse', MAIN);
  if (tryGit(wt, 'merge-base', '--is-ancestor', main, 'HEAD').ok) return save({ phase: DRY ? 'handoff' : 'publish' });
  const m = tryGit(wt, 'merge', '--no-edit', '-m', `Merge ${MAIN} into ${c.branch}`, main);
  save({ main_sha: main });
  if (m.ok) return save({ head: head(), phase: 'verify', after_verify: DRY ? 'handoff' : 'publish' }); // clean merge: re-run checks only
  const conflicted = git(wt, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  const outside = outOfScope(conflicted, c.allowed_files);
  if (outside.length) { git(wt, 'merge', '--abort'); stop('needs_replan', { reason: `main conflicts outside the allowlist: ${outside.join(', ')}` }); }
  if (st.sync_rounds >= 2) { git(wt, 'merge', '--abort'); stop('needs_replan', { reason: 'merge conflicts unresolved after 2 rounds' }); }
  save({ sync_rounds: st.sync_rounds + 1 });
  // Conflicts are resolved by the coder and then go through the full verify + review again.
  nextRound(conflicted.map((p) => ({ source: 'conflict', key: `${p}@${main.slice(0, 7)}`, file: p, problem: `merge conflict with ${MAIN}: resolve the markers keeping both sides' intent` })), { counts: false });
}

function prBody() {
  const rows = (st.checks ?? []).map((r) => `| ${r.id} | \`${r.cmd}\` | exit ${r.code} ${r.ok ? '✅' : '❌'} |`);
  const judged = (st.review?.acceptance ?? []).map((a) => `| ${a.id} | review | ${a.result === 'pass' ? '✅' : '❌'} ${a.evidence} |`);
  const e2e = (st.e2e ?? []).map((r) => `| ${r.id} | \`${r.cmd}\` | exit ${r.code} ${r.code === 0 ? '✅' : '❌'} |`);
  const notes = (st.review?.non_blocking ?? []).map((f) => `- [${f.severity}] ${f.category} — ${f.file}${f.line ? `:${f.line}` : ''} — ${f.problem}`);
  return [
    '## Summary', '', c.pr.summary, '',
    '## Acceptance', '', '| AC | proved by | result |', '| --- | --- | --- |', ...rows, ...e2e, ...judged, '',
    `Crew run \`${run}\`, contract ${id} v${c.version}: approved in round ${st.review?.round ?? st.round}.`,
    ...(notes.length ? ['', '## Review notes (non-blocking)', '', ...notes] : []),
    ...(c.manual_acceptance ? ['', '## Manual acceptance outstanding', '', c.manual_acceptance] : []),
    '', `${c.refs_only ? 'Refs' : 'Closes'} #${c.issue}`,
  ].join('\n');
}

async function publish() {
  await retry(() => git(wt, 'push', '-u', CONFIG.remote, c.branch));
  const bodyFile = join(logs, 'pr-body.md');
  writeFileSync(bodyFile, withFooter(prBody()));
  const open = JSON.parse(gh('pr', 'list', '--head', c.branch, '--state', 'open', '--json', 'number'));
  let pr = open[0]?.number;
  if (pr) gh('pr', 'edit', String(pr), '--body-file', bodyFile);
  else {
    const url = gh('pr', 'create', '--base', CONFIG.main_branch, '--head', c.branch, '--title', c.pr.title, '--body-file', bodyFile);
    pr = Number(url.trim().split('/').pop());
  }
  save({ pr, head: head(), phase: 'ci' });
}

async function ci() {
  const sha = head();
  // Checks can take a moment to register after a push.
  let checks = [];
  for (let i = 0; i < 10 && !checks.length; i++) {
    await shell(`gh pr checks ${st.pr} --watch --fail-fast --interval 30`, { cwd: ROOT, logFile: join(logs, `ci-${sha.slice(0, 7)}.log`), timeoutMin: c.timeout_min.ci, onSpawn });
    try { checks = JSON.parse(gh('pr', 'checks', String(st.pr), '--json', 'name,bucket,link')); } catch { checks = []; }
    if (!checks.length) await new Promise((r) => setTimeout(r, 30_000));
  }
  if (!checks.length) { save({ resume_phase: 'ci' }); stop('help', { reason: `no CI checks reported for PR #${st.pr}` }); }
  const failed = checks.filter((ch) => ['fail', 'cancel'].includes(ch.bucket));
  const pending = checks.filter((ch) => ch.bucket === 'pending');
  if (!failed.length && pending.length) { save({ resume_phase: 'ci' }); stop('help', { reason: `CI still pending after ${c.timeout_min.ci} min: ${pending.map((p) => p.name).join(', ')}` }); }
  if (!failed.length) return save({ phase: 'handoff' });
  const runIds = [...new Set(failed.map((f) => f.link.match(/runs\/(\d+)/)?.[1]).filter(Boolean))];
  if (st.ci_rerun_for !== sha) { // one automatic re-run per head before blaming the diff
    runIds.forEach((r) => tryGh('run', 'rerun', r, '--failed'));
    save({ ci_rerun_for: sha });
    return new Promise((r) => setTimeout(r, 60_000)); // let the re-run register before watching again
  }
  nextRound(failed.map((f) => {
    const runId = f.link.match(/runs\/(\d+)/)?.[1];
    let out = '';
    try { out = gh('run', 'view', runId, '--log-failed').split('\n').slice(-60).join('\n'); } catch {}
    return { source: 'ci', key: `${f.name}#${outputKey(out)}`, problem: `CI check "${f.name}" failed twice on ${sha.slice(0, 7)}`, output: out };
  }));
}
function tryGh(...args) { try { return gh(...args); } catch { return null; } }

function handoff() {
  const data = { pr: st.pr ?? null, head: head(), rounds: st.round, refs_only: c.refs_only, cost_usd: Math.round(st.cost * 100) / 100, review_notes: st.review?.non_blocking?.length ?? 0, dry_run: DRY };
  stop('ready_to_merge', data);
}

const PHASES = { prepare, code, verify, review, sync, publish, ci, handoff };
try {
  log(`driver ${id} v${c.version} start: phase=${st.phase} round=${st.round}${DRY ? ' (dry run)' : ''}`);
  save();
  for (;;) {
    const step = PHASES[st.phase];
    if (!step) throw new Error(`driver cannot continue from phase ${st.phase}`);
    await step();
  }
} catch (e) {
  if (!(e instanceof Stop)) {
    log(`driver error: ${e.stack ?? e}`);
    save({ resume_phase: st.phase, error: String(e.message ?? e).slice(0, 500) });
    process.exit(1); // the orchestrator sees a dead driver without a status event and triages it
  }
  log(`driver ${id}: ${e.message}`);
  process.exit(0);
}

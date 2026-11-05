#!/usr/bin/env node
// Crew orchestrator: supervises one batch.
//   node orchestrator.mjs <run> <batch>
// Scheduling is rules: a task starts when it is runnable, its dependencies are merged and a slot is free. Health is
// rules: dead or silent drivers are noticed by pid and heartbeat. Only the diagnosis of a failure is judgment, so
// that, and only that, goes to a `claude -p` triage call, which may repair the local environment.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  DONE_FOR_DEPENDANTS, FINISHED, ROOT, RUNNABLE, SKILL, WAITING_ON_BOSS, appendEvent, callClaude, contractPath,
  identify, isRunning, killGroup, lastStatus, loadBatch, loadContract, log, now, readEvents, readJson, runDir, sleep, tail, worktreeOf, writeJson,
} from './lib.mjs';

const [run, batchId] = process.argv.slice(2);
if (!run || !batchId) { console.error('usage: orchestrator.mjs <run> <batch>'); process.exit(2); }

const HEARTBEAT_STALE_MIN = 5; // drivers write every minute, even while a coder runs
const MAX_TRIAGES = 2;
const batch = loadBatch(run, batchId);
const orchFile = join(runDir(run), `orch-${batchId}.json`);
const orch = readJson(orchFile, { drivers: {} });
const startedAt = now();
const SELF = identify(process.pid);
const save = () => writeJson(orchFile, Object.assign(orch, { proc: SELF, updated: now() }));
const emit = (type, task, data) => appendEvent(run, type, task, data, 'orchestrator');
const driverStatus = (id) => readJson(join(runDir(run), 'drivers', `${id}.json`), {});
const triaging = new Set();

function launch(id, reason) {
  const d = orch.drivers[id];
  killGroup(driverStatus(id).child); // never two coders in one worktree
  const logFile = join(runDir(run), 'logs', id, 'driver.log');
  mkdirSync(join(runDir(run), 'logs', id), { recursive: true });
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [join(SKILL, 'driver.mjs'), run, id], {
    cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, CREW_DRY: batch.dry_run ? '1' : '0' },
  });
  closeSync(fd);
  child.unref();
  const events = readEvents(run);
  Object.assign(d, { proc: identify(child.pid), launched_at: now(), launched_after: lastStatus(events, id)?.ts ?? null });
  save();
  emit('driver_launched', id, { pid: child.pid, reason });
  log(`launched driver ${id} pid ${child.pid} (${reason})`);
}

function kill(id) {
  const d = orch.drivers[id];
  killGroup(driverStatus(id).child);
  killGroup(d.proc);
  d.proc = null;
  save();
}

// Judgment only here: why did a driver fail or stall, can the environment be fixed, should it retry?
async function triage(id, why, detail) {
  const d = orch.drivers[id];
  if (d.triages >= MAX_TRIAGES) {
    emit('escalate', id, { reason: `${why} after ${d.triages} triaged retries`, detail });
    return;
  }
  d.triages += 1;
  save();
  triaging.add(id);
  try {
    const c = loadContract(run, id);
    const logFile = join(runDir(run), 'logs', id, 'driver.log');
    const prompt = `Run: ${run} · task: ${id} · worktree: ${worktreeOf(id)}
Problem: ${why}
Detail: ${JSON.stringify(detail ?? {})}
Driver status file:
${JSON.stringify(driverStatus(id), null, 2)}
Driver log (tail):
${existsSync(logFile) ? tail(readFileSync(logFile, 'utf8'), 60) : '(none)'}
Per-step logs: ${join(runDir(run), 'logs', id)}
Contract: ${contractPath(run, id)} (locks: ${c.locks.join(', ') || 'none'})`;
    log(`triage ${id}: ${why}`);
    const r = await callClaude({
      role: 'triage', model: 'sonnet', prompt, budget: c.budget_usd.triage, timeoutMin: 20, cwd: ROOT,
      logFile: join(runDir(run), 'logs', id, `triage-${d.triages}.jsonl`),
    });
    const { action, diagnosis, fixed } = r.ok ? r.output : { action: 'escalate', diagnosis: `triage call failed: ${r.failure}` };
    emit('triage', id, { why, action, diagnosis, fixed });
    const state = lastStatus(readEvents(run), id)?.type ?? 'none';
    if (action === 'retry') {
      if (state === 'help') emit('retry', id, { reason: diagnosis });
      d.restarts += 1;
      emit('driver_restarted', id, { why, diagnosis, restart: d.restarts });
      launch(id, `retry after triage: ${why}`);
    } else {
      emit(action, id, { reason: diagnosis });
    }
  } finally {
    triaging.delete(id);
  }
}

const startTriage = (id, why, detail) => triage(id, why, detail).catch((e) => log(`triage ${id} failed: ${e.stack ?? e}`));

async function tick() {
  const events = readEvents(run);
  if (events.some((e) => e.type === 'stop' && e.ts >= startedAt)) {
    Object.keys(orch.drivers).forEach(kill);
    log('stop event: drivers stopped');
    process.exit(0);
  }
  const state = (id) => lastStatus(events, id)?.type ?? 'none';
  // A dry run never gets a PR, so its hand-off is the end.
  const finished = (id) => FINISHED.has(state(id)) || (batch.dry_run && state(id) === 'ready_to_merge');
  let running = batch.tasks.filter((id) => isRunning(orch.drivers[id]?.proc)).length;

  for (const id of batch.tasks) {
    const d = (orch.drivers[id] ??= { proc: null, restarts: 0, triages: 0 });
    if (triaging.has(id)) continue;
    const s = state(id);
    const alive = isRunning(d.proc);
    if (FINISHED.has(s) || WAITING_ON_BOSS.has(s)) continue;

    if (alive) {
      const updated = driverStatus(id).updated;
      if (updated && Date.now() - Date.parse(updated) > HEARTBEAT_STALE_MIN * 60_000) {
        kill(id);
        startTriage(id, `driver hung (no heartbeat since ${updated})`, { phase: driverStatus(id).phase });
      }
      continue;
    }
    if (s === 'help') { startTriage(id, 'driver asked for help', lastStatus(events, id).data); continue; }

    // Runnable and not running: either it never started, or its driver died without handing the task off.
    const handedOffSinceLaunch = d.launched_at && (lastStatus(events, id)?.ts ?? null) !== d.launched_after;
    if (d.proc && !handedOffSinceLaunch && RUNNABLE.has(s)) {
      kill(id); // its claude -p may have outlived it
      startTriage(id, 'driver exited without a status event', { error: driverStatus(id).error, phase: driverStatus(id).phase });
      continue;
    }
    const deps = loadContract(run, id).depends_on;
    if (!deps.every((dep) => DONE_FOR_DEPENDANTS.has(state(dep)))) continue;
    if (running >= batch.max_parallel) continue;
    launch(id, s === 'none' ? 'start' : s);
    running += 1;
  }

  const states = batch.tasks.map((id) => `${id}=${state(id)}`);
  if (batch.tasks.every(finished) && !triaging.size) {
    emit('batch_done', batchId, { tasks: states.join(' ') });
    log(`batch done: ${states.join(' ')}`);
    process.exit(0);
  }
}

// A (re)start is the boss stepping in: forget launches whose driver is gone, so they don't read as crashes, and
// give each task a fresh triage budget.
for (const d of Object.values(orch.drivers)) if (!isRunning(d.proc)) Object.assign(d, { proc: null, launched_at: null, triages: 0 });

log(`orchestrator ${run}/${batchId} start: ${batch.tasks.join(', ')} (max_parallel ${batch.max_parallel}${batch.dry_run ? ', dry run' : ''})`);
emit('orchestrator_started', batchId, { pid: process.pid });
save();
for (;;) {
  try { await tick(); } catch (e) { log(`tick error: ${e.stack ?? e}`); }
  await sleep(15_000);
}

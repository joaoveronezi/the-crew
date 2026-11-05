import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DEFAULTS, callShare, callUsage, checkTransition, envFiles, fingerprint, loadConfig, mainCheckoutEntries, npmScriptsReferenced, orderingErrors, outOfScope, repeated, shapeErrors, sumCosts, taskState, withDefaults } from '../skill/lib.mjs';

const contract = (over = {}) => withDefaults({
  id: 'T-1', version: 1, issue: 7, title: 't', batch: 'b', branch: 'agent/T-1-x', commit: 'docs: x (T-1)',
  models: { coder: 'haiku', reviewer: 'sonnet' }, allowed_files: [{ path: 'docs/a.md', op: 'edit' }],
  gates: ['npm run check:docs'], pr: { title: 't', summary: 's', closes_issue: true }, ...over,
});

test('state machine allows the happy path and refuses skipped steps', () => {
  assert.equal(checkTransition('none', 'ready_to_merge'), null);
  assert.equal(checkTransition('ready_to_merge', 'merged'), null);
  assert.match(checkTransition('none', 'merged'), /illegal/);
  assert.match(checkTransition('merged', 'retry'), /illegal/);
  assert.match(checkTransition('needs_replan', 'ready_to_merge'), /illegal/);
  assert.equal(checkTransition('none', 'round'), null, 'informational events are always allowed');
});

test('task state is the last status event, ignoring informational ones', () => {
  const events = [
    { task: 'A', type: 'driver_launched' }, { task: 'A', type: 'ready_to_merge' },
    { task: 'B', type: 'blocked' }, { task: 'A', type: 'round' },
  ];
  assert.equal(taskState(events, 'A'), 'ready_to_merge');
  assert.equal(taskState(events, 'C'), 'none');
});

test('a valid contract has no shape errors; broken fields are named', () => {
  assert.deepEqual(shapeErrors(contract()), []);
  const errors = shapeErrors(contract({ branch: 'main', models: { coder: 'gpt', reviewer: 'sonnet' }, gates: [], max_rounds: 9 }));
  assert.ok(errors.some((e) => /branch/.test(e)));
  assert.ok(errors.some((e) => /models/.test(e)));
  assert.ok(errors.some((e) => /nothing deterministic/.test(e)));
  assert.ok(errors.some((e) => /max_rounds/.test(e)));
  assert.ok(shapeErrors(contract({ issue: null })).some((e) => /issue/.test(e)));
  assert.deepEqual(shapeErrors(contract({ issue: null }), { dryRun: true }), []);
});

test('e2e implies the e2e lock; manual acceptance implies Refs', () => {
  const c = contract({ e2e: [{ id: 'e2e-list', cmd: 'npm run e2e' }], manual_acceptance: 'screen reader on a phone' });
  assert.deepEqual(c.locks, ['e2e']);
  assert.equal(c.refs_only, true);
  assert.equal(contract().refs_only, false);
});

test('overlapping tasks must be ordered by depends_on', () => {
  const a = contract({ id: 'A' });
  const b = contract({ id: 'B', branch: 'agent/B' });
  assert.equal(orderingErrors([a, b]).length, 1);
  assert.deepEqual(orderingErrors([a, contract({ id: 'B', branch: 'agent/B', depends_on: ['A'] })]), []);
  const lockA = contract({ id: 'A', allowed_files: [{ path: 'api/package.json', op: 'edit' }] });
  const lockB = contract({ id: 'B', allowed_files: [{ path: 'api/db/migrations/0002_add_x.sql', op: 'create' }] });
  assert.equal(orderingErrors([lockA, lockB]).length, 1, 'same project lockfile + migration');
  const other = contract({ id: 'C', allowed_files: [{ path: 'web/package.json', op: 'edit' }] });
  assert.deepEqual(orderingErrors([lockA, other]), [], 'different projects are independent');
  assert.ok(orderingErrors([contract({ id: 'A', depends_on: ['B'] }), contract({ id: 'B', depends_on: ['A'] })]).some((e) => /cycle/.test(e)));
});

test('scope check and repeated findings', () => {
  assert.deepEqual(outOfScope(['docs/a.md', 'docs/b.md'], [{ path: 'docs/a.md', op: 'edit' }]), ['docs/b.md']);
  const f = [{ source: 'review', key: 'a.ts:security' }].map(fingerprint);
  assert.deepEqual(repeated(f, f), ['review:a.ts:security']);
  assert.deepEqual(repeated([], f), []);
});

test('npm scripts referenced by commands', () => {
  assert.deepEqual(npmScriptsReferenced('cd web && npm test'), [{ dir: 'web', script: 'test' }]);
  assert.deepEqual(npmScriptsReferenced('npm --prefix api run check'), [{ dir: 'api', script: 'check' }]);
  assert.deepEqual(npmScriptsReferenced('npm run check:docs'), [{ dir: '.', script: 'check:docs' }]);
  assert.deepEqual(npmScriptsReferenced('cd api && npx tsx --test test/a.test.ts'), []);
});

test('review convergence: partial is progress, not_fixed twice stops, unmentioned stays open', async () => {
  const { reviewProgress } = await import('../skill/lib.mjs');
  const prior = [{ id: 'R1.1', problem: 'a' }, { id: 'R1.2', problem: 'b' }, { id: 'R1.3', problem: 'c' }];
  const r2 = reviewProgress(prior, [{ index: 1, status: 'fixed' }, { index: 2, status: 'not_fixed' }], {});
  assert.deepEqual(r2.open.map((f) => f.id), ['R1.2', 'R1.3']);
  assert.deepEqual(r2.stuck, []);
  const r3 = reviewProgress(r2.open, [{ index: 1, status: 'not_fixed' }, { index: 2, status: 'partial', note: 'half' }], r2.strikes);
  assert.deepEqual(r3.stuck.map((f) => f.id), ['R1.2']);
  assert.deepEqual(r3.open.map((f) => [f.id, f.note]), [['R1.3', 'half']]);
  const r4 = reviewProgress(r3.open, [{ index: 1, status: 'partial' }], r3.strikes);
  assert.equal(r4.strikes['R1.3'], 0, 'partial resets the count');
});

test('deterministic failures repeat only with identical output (timings ignored)', async () => {
  const { outputKey } = await import('../skill/lib.mjs');
  assert.equal(outputKey('fail: x (12ms)'), outputKey('fail: x (340ms)'));
  assert.notEqual(outputKey('fail: x'), outputKey('fail: y'));
});

test('process identity rejects a recycled pid', async () => {
  const { identify, isRunning } = await import('../skill/lib.mjs');
  const me = identify(process.pid);
  assert.ok(isRunning(me));
  assert.equal(isRunning({ ...me, started: 'Mon Jan  1 00:00:00 2001' }), false);
  assert.equal(isRunning(null), false);
});

test('models default to a haiku coder and a sonnet reviewer, and either can be overridden', () => {
  const { models: _, ...bare } = contract();
  assert.deepEqual(withDefaults(bare).models, { coder: 'haiku', reviewer: 'sonnet' });
  assert.deepEqual(withDefaults({ ...bare, models: { reviewer: 'opus' } }).models, { coder: 'haiku', reviewer: 'opus' });
  assert.deepEqual(shapeErrors(withDefaults(bare)), []);
});

test('call usage sums every model in the call; a missing result is all zeros', () => {
  const result = { modelUsage: {
    'claude-haiku': { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 100, cacheCreationEphemeral1hInputTokens: 100, cacheReadInputTokens: 1000 },
    'claude-sonnet': { inputTokens: 2, outputTokens: 1, cacheCreationInputTokens: 50, cacheReadInputTokens: 500 },
  } };
  assert.deepEqual(callUsage(result), { input: 12, output: 6, cache_write: 150, cache_write_1h: 100, cache_read: 1500 });
  assert.deepEqual(callUsage(null), { input: 0, output: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0 });
});

test('cost totals group ledger entries by key, triage included', () => {
  const entries = [
    { task: 'A', role: 'coder', cost: 0.25, tokens: { cache_write: 100, cache_read: 900 } },
    { task: 'A', role: 'coder', cost: 0.05, tokens: { cache_write: 10, cache_read: 990 } },
    { task: 'A', role: 'triage', cost: 0.5 },
    { task: 'B', role: 'reviewer', cost: 1 },
  ];
  const byTask = sumCosts(entries, (e) => e.task);
  assert.equal(byTask.get('A').calls, 3);
  assert.equal(byTask.get('A').cost, 0.8);
  assert.equal(byTask.get('A').cache_read, 1890);
  assert.equal(byTask.get('B').cost, 1);
});

test('a resumed call is charged only its share of the cumulative session totals', () => {
  const total = { cost: 0.5, tokens: { input: 30, output: 20, cache_write: 1100, cache_write_1h: 1100, cache_read: 9000 } };
  const prior = { cost: 0.3, tokens: { input: 10, output: 15, cache_write: 1000, cache_write_1h: 1000, cache_read: 4000 } };
  const share = callShare(total, prior);
  assert.ok(Math.abs(share.cost - 0.2) < 1e-9);
  assert.deepEqual(share.tokens, { input: 20, output: 5, cache_write: 100, cache_write_1h: 100, cache_read: 5000 });
  assert.deepEqual(callShare(total, null), total, 'a fresh call is its own total');
});

test('config: defaults fill missing fields, and the sandbox section merges', () => {
  const c = loadConfig({ main_branch: 'trunk', sandbox: { allowed_domains: ['pypi.org'] } });
  assert.equal(c.main_branch, 'trunk');
  assert.equal(c.remote, 'origin');
  assert.deepEqual(c.sandbox.allowed_domains, ['pypi.org']);
  assert.deepEqual(c.sandbox.extra_write, []);
  assert.equal(loadConfig({}).commit_trailer, null, 'no attribution unless configured');
});

test('config: branch prefix and lock names come from the config', () => {
  const config = loadConfig({ branch_prefix: 'bot/', locks: ['e2e', 'redis'] });
  assert.ok(shapeErrors(contract(), { config }).some((e) => /bot\/<plan-id>/.test(e)), 'agent/ branch refused under bot/');
  assert.deepEqual(shapeErrors(contract({ branch: 'bot/T-1-x', locks: ['redis'] }), { config }), []);
  assert.ok(shapeErrors(contract({ branch: 'bot/T-1-x', locks: ['db'] }), { config }).some((e) => /unknown lock db/.test(e)));
});

test('config: ordering paths decide which shared project files force an order', () => {
  const a = contract({ id: 'A', allowed_files: [{ path: 'api/schema.graphql', op: 'edit' }] });
  const b = contract({ id: 'B', allowed_files: [{ path: 'api/resolvers.ts', op: 'edit' }] });
  assert.deepEqual(orderingErrors([a, b]), [], 'not an ordering path by default');
  const config = loadConfig({ ordering_paths: [...CONFIG_DEFAULTS.ordering_paths, '\\.graphql$'] });
  const c = contract({ id: 'C', allowed_files: [{ path: 'api/other.graphql', op: 'create' }] });
  assert.equal(orderingErrors([a, c], { config }).length, 1, 'two graphql files in one project');
});

test('sandbox paths: every top-level entry but the worktrees and .git, and .env files one level deep', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-'));
  for (const d of ['.git', '.worktrees', 'src', 'api', 'node_modules']) mkdirSync(join(root, d));
  for (const f of ['README.md', '.env', 'api/.env.local', 'src/index.ts', 'node_modules/.env']) writeFileSync(join(root, f), '');
  const names = mainCheckoutEntries(root, '.worktrees').map((e) => e.name).sort();
  assert.deepEqual(names, ['.env', 'README.md', 'api', 'node_modules', 'src']);
  assert.deepEqual(envFiles(root).map((f) => f.slice(root.length + 1)).sort(), ['.env', 'api/.env.local']);
});

test('the example run in examples/ is a valid contract', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = new URL('../examples/run/20260101-truncate-titles/', import.meta.url);
  const raw = JSON.parse(readFileSync(new URL('contracts/WEB-TITLE-001.json', dir), 'utf8'));
  const batch = JSON.parse(readFileSync(new URL(`batches/${raw.batch}.json`, dir), 'utf8'));
  assert.deepEqual(shapeErrors(withDefaults(raw), { config: loadConfig(JSON.parse(readFileSync(new URL('../examples/crew.config.json', import.meta.url), 'utf8'))) }), []);
  assert.ok(batch.tasks.includes(raw.id));
});

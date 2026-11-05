import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTransition, fingerprint, identify, isRunning, npmScriptsReferenced, orderingErrors, outOfScope, outputKey, repeated,
  reviewProgress, sandboxSettings, shapeErrors, taskState, withConfigDefaults, withDefaults, withTrailer, ROOT, callShare, callUsage, sumCosts, baseRef, isGithub, ROLE_TOOLS,
} from '../skill/lib.mjs';
import {
  issueErrors, normalizeIssue, parseFrontMatter, parseJsonIssues, parseMdIssues, updateFrontMatterIssue, updateJsonIssues, updateMdIssue,
} from '../skill/issues.mjs';
import { githubTracker, parseGithubIssues } from '../skill/issues.mjs';
import * as todoAdapter from '../skill/templates/issues-adapter.mjs';

const contract = (over = {}) => withDefaults({
  id: 'T-1', version: 1, issue: '7', title: 't', summary: 's', batch: 'b', branch: 'crew/T-1-x', commit: 'docs: x (T-1)',
  models: { coder: 'haiku', reviewer: 'sonnet' }, allowed_files: [{ path: 'docs/a.md', op: 'edit' }], gates: ['npm test'], ...over,
});

test('state machine allows the happy path and refuses skipped steps', () => {
  assert.equal(checkTransition('none', 'ready_to_merge'), null);
  assert.equal(checkTransition('ready_to_merge', 'merged'), null);
  assert.match(checkTransition('none', 'merged'), /illegal/);
  assert.match(checkTransition('merged', 'retry'), /illegal/);
  assert.equal(checkTransition('none', 'round'), null, 'informational events are always allowed');
  assert.equal(taskState([{ task: 'A', type: 'ready_to_merge' }, { task: 'A', type: 'round' }], 'A'), 'ready_to_merge');
});

test('contract shape: branch prefix, issue, summary and declared locks', () => {
  assert.deepEqual(shapeErrors(contract()), []);
  const errors = shapeErrors(contract({ branch: 'main', summary: '', locks: ['db'], max_rounds: 9 }), { lockNames: [] });
  for (const re of [/branch must start with crew\//, /summary/, /unknown lock db/, /max_rounds/]) assert.ok(errors.some((e) => re.test(e)), String(re));
  assert.deepEqual(shapeErrors(contract({ locks: ['db'], checks: [{ id: 'AC1', cmd: 'x', expect_exit: 0, locks: ['sim'] }] }), { lockNames: ['db', 'sim'] }), []);
  assert.deepEqual(shapeErrors(contract({ branch: 'feat/T-1' }), { branchPrefix: 'feat/' }), []);
  assert.ok(shapeErrors(contract({ issue: null })).some((e) => /issue/.test(e)));
  assert.deepEqual(shapeErrors(contract({ issue: null }), { dryRun: true }), []);
});

test('close_issue false or manual acceptance keeps the issue open', () => {
  assert.equal(contract().keep_open, false);
  assert.equal(contract({ close_issue: false }).keep_open, true);
  assert.equal(contract({ manual_acceptance: 'try it on a phone' }).keep_open, true);
});

test('overlapping or same-sensitive-area tasks must be ordered by depends_on', () => {
  const a = contract({ id: 'A' });
  const b = contract({ id: 'B', branch: 'crew/B' });
  assert.equal(orderingErrors([a, b]).length, 1);
  assert.deepEqual(orderingErrors([a, contract({ id: 'B', branch: 'crew/B', depends_on: ['A'] })]), []);
  const m1 = contract({ id: 'M1', allowed_files: [{ path: 'db/migrations/1.sql', op: 'create' }] });
  const m2 = contract({ id: 'M2', branch: 'crew/M2', allowed_files: [{ path: 'db/migrations/2.sql', op: 'create' }] });
  assert.deepEqual(orderingErrors([m1, m2]), [], 'no sensitive paths configured');
  assert.equal(orderingErrors([m1, m2], ['^db/migrations/']).length, 1);
  assert.ok(orderingErrors([contract({ id: 'A', depends_on: ['B'] }), contract({ id: 'B', depends_on: ['A'] })]).some((e) => /cycle/.test(e)));
});

test('scope, repeats, convergence and output keys', () => {
  assert.deepEqual(outOfScope(['docs/a.md', 'docs/b.md'], [{ path: 'docs/a.md', op: 'edit' }]), ['docs/b.md']);
  const f = [{ source: 'check', key: 'AC1#x' }].map(fingerprint);
  assert.deepEqual(repeated(f, f), ['check:AC1#x']);
  assert.equal(outputKey('fail (12ms)'), outputKey('fail (340ms)'));
  const prior = [{ id: 'R1.1' }, { id: 'R1.2' }];
  const r2 = reviewProgress(prior, [{ index: 1, status: 'fixed' }, { index: 2, status: 'not_fixed' }], {});
  const r3 = reviewProgress(r2.open, [{ index: 1, status: 'not_fixed' }], r2.strikes);
  assert.deepEqual(r3.stuck.map((x) => x.id), ['R1.2']);
  assert.equal(reviewProgress(r2.open, [{ index: 1, status: 'partial' }], r2.strikes).strikes['R1.2'], 0);
});

test('npm scripts referenced by commands', () => {
  assert.deepEqual(npmScriptsReferenced('cd web && npm test'), [{ dir: 'web', script: 'test' }]);
  assert.deepEqual(npmScriptsReferenced('npm --prefix api run check'), [{ dir: 'api', script: 'check' }]);
  assert.deepEqual(npmScriptsReferenced('pytest -q'), []);
});

test('process identity rejects a recycled pid', () => {
  const me = identify(process.pid);
  assert.ok(isRunning(me));
  assert.equal(isRunning({ ...me, started: 'Mon Jan  1 00:00:00 2001' }), false);
});

test('sandbox rules come from the config and never cover the worktree folder', () => {
  const config = withConfigDefaults({ secretFiles: ['.env', 'config/*.key'], network: { allowedDomains: ['pypi.org'] } });
  const s = sandboxSettings(ROOT, config);
  assert.deepEqual(s.sandbox.network.allowedDomains, ['pypi.org']);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.ok(s.permissions.deny.includes(`Read(/${ROOT}/**/config/*.key)`));
  assert.ok(s.sandbox.filesystem.denyRead.includes(join(ROOT, '.env')), 'literal secret files are OS-denied too');
  assert.ok(!s.sandbox.filesystem.denyRead.some((p) => p.includes('*')), 'globs stay out of OS rules');
  assert.ok(!s.permissions.deny.some((r) => r.includes(`/${config.worktreeDir}`)), 'worktrees stay editable');
});

test('issues.json: parse, update status and log, keep the wrapper', () => {
  const text = JSON.stringify({ issues: [{ id: 12, title: 'CSV', status: 'todo', depends_on: [9] }, { id: 9, title: 'S3', status: 'closed' }] });
  const list = parseJsonIssues(text).map(normalizeIssue);
  assert.deepEqual(list.map((i) => [i.id, i.status]), [['12', 'open'], ['9', 'done']]);
  assert.deepEqual(list[0].depends_on, ['9']);
  const updated = JSON.parse(updateJsonIssues(text, '12', { status: 'in_progress', note: 'run x' }));
  assert.equal(updated.issues[0].status, 'in_progress');
  assert.match(updated.issues[0].log[0], /run x$/);
  assert.equal(updated.issues[1].status, 'closed', 'other issues untouched');
});

test('issues/ front matter: parse with fallbacks, update keeps the body', () => {
  const text = '---\ntitle: CSV export\nstatus: doing\ndepends_on: [9, 10]\n---\nUsers can export.\n';
  const issue = parseFrontMatter(text, '12-csv');
  assert.deepEqual([issue.id, issue.title, issue.status, issue.depends_on], ['12-csv', 'CSV export', 'in_progress', ['9', '10']]);
  const out = updateFrontMatterIssue(text, { status: 'done', note: 'merged' });
  assert.match(out, /^status: done$/m);
  assert.match(out, /Users can export\./);
  assert.match(out, /## Log\n- \d{4}-\d\d-\d\d: merged\n$/);
  assert.equal(parseFrontMatter('# Title only\n', 'x').title, 'Title only');
});

test('issues.md: several heading styles, status line formats, update touches one section', () => {
  const text = '# Backlog\n\n## 12: CSV export\nStatus: open\n\nBody.\n\n## [AUTH-1] Login\n**Status:** doing\n\n## #9 S3\n**Status: done**\n';
  const list = parseMdIssues(text);
  assert.deepEqual(list.map((i) => [i.id, i.title, i.status]), [['12', 'CSV export', 'open'], ['AUTH-1', 'Login', 'in_progress'], ['9', 'S3', 'done']]);
  const out = updateMdIssue(text, 'AUTH-1', { status: 'done', note: 'merged' });
  assert.match(out, /\*\*Status:\*\* done/);
  assert.match(out, /^Status: open$/m, 'other sections untouched');
  assert.match(out, /- Log \d{4}-\d\d-\d\d: merged\n\n## #9 S3/);
  assert.match(updateMdIssue(text, '9', { status: 'open' }), /\*\*Status: open\*\*/);
  assert.equal(parseMdIssues('## 1: x\nThe status of the API is unclear\n')[0].status, 'open', 'prose without a colon is not a status line');
});

test('tracker validation catches duplicates, missing titles, bad statuses and unknown dependencies', () => {
  const errors = issueErrors([
    normalizeIssue({ id: 1, title: 'a', status: 'open' }), normalizeIssue({ id: 1, title: '', status: 'maybe', depends_on: ['7'] }),
  ]);
  for (const re of [/duplicate issue id 1/, /no title/, /unknown status "maybe"/, /unknown issue 7/]) assert.ok(errors.some((e) => re.test(e)), String(re));
});

test('the adapter template reads and updates a TODO.md checklist', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-adapter-'));
  writeFileSync(join(root, 'TODO.md'), '# Todo\n- [ ] #12 Add CSV export (depends: #9)\n- [x] #9 Store exports\n');
  const list = todoAdapter.listIssues(root).map(normalizeIssue);
  assert.deepEqual(list.map((i) => [i.id, i.title, i.status, i.depends_on]), [['12', 'Add CSV export', 'open', ['9']], ['9', 'Store exports', 'done', []]]);
  assert.deepEqual(issueErrors(list), []);
  todoAdapter.updateIssue(root, '12', { status: 'in_progress', note: 'run x' });
  const text = readFileSync(join(root, 'TODO.md'), 'utf8');
  assert.match(text, /- \[~\] #12 Add CSV export \(depends: #9\)\n  - \d{4}-\d\d-\d\d: run x\n- \[x\] #9/);
  todoAdapter.updateIssue(root, '12', { status: 'done', note: 'merged' });
  assert.match(readFileSync(join(root, 'TODO.md'), 'utf8'), /- \[x\] #12 .*\n  - \S+: run x\n  - \S+: merged\n- \[x\] #9/, 'notes stay in order');
});

test('commits carry no trailer unless the project configures one', () => {
  assert.equal(withTrailer('fix: x', { commitTrailer: null }), 'fix: x');
  assert.equal(withTrailer('fix: x', { commitTrailer: 'Signed-off-by: A <a@example.com>' }), 'fix: x\n\nSigned-off-by: A <a@example.com>');
  assert.equal(withTrailer('fix: x\n\nbody\n\nCrew-Task: r/T', { commitTrailer: 'T: v' }), 'fix: x\n\nbody\n\nCrew-Task: r/T\nT: v');
});

test('models default to a haiku coder and a sonnet reviewer, and either can be overridden', () => {
  assert.deepEqual(withDefaults({ id: 'T' }).models, { coder: 'haiku', reviewer: 'sonnet' });
  assert.deepEqual(withDefaults({ id: 'T', models: { reviewer: 'opus' } }).models, { coder: 'haiku', reviewer: 'opus' });
});

test('call usage sums every model in the call; a missing result is all zeros', () => {
  const result = { modelUsage: {
    'claude-haiku': { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 100, cacheCreationEphemeral1hInputTokens: 100, cacheReadInputTokens: 1000 },
    'claude-sonnet': { inputTokens: 2, outputTokens: 1, cacheCreationInputTokens: 50, cacheReadInputTokens: 500 },
  } };
  assert.deepEqual(callUsage(result), { input: 12, output: 6, cache_write: 150, cache_write_1h: 100, cache_read: 1500 });
  assert.deepEqual(callUsage(null), { input: 0, output: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0 });
});

test('a resumed call is charged only its share of the cumulative session totals', () => {
  const total = { cost: 0.5, tokens: { input: 30, output: 20, cache_write: 1100, cache_write_1h: 1100, cache_read: 9000 } };
  const prior = { cost: 0.3, tokens: { input: 10, output: 15, cache_write: 1000, cache_write_1h: 1000, cache_read: 4000 } };
  const share = callShare(total, prior);
  assert.ok(Math.abs(share.cost - 0.2) < 1e-9);
  assert.deepEqual(share.tokens, { input: 20, output: 5, cache_write: 100, cache_write_1h: 100, cache_read: 5000 });
  assert.deepEqual(callShare(total, null), total, 'a fresh call is its own total');
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

test('github issues: state, dependencies from the body, and idempotent write-back', async () => {
  const listed = JSON.stringify([
    { number: 12, title: 'Add CSV export', state: 'OPEN', labels: [{ name: 'P1' }], body: 'Users export orders.\n\nDepends on #9, #10' },
    { number: 9, title: 'Store exports', state: 'CLOSED', labels: [], body: '' },
    { number: 10, title: 'Export button', state: 'OPEN', labels: [], body: '**Depends on:** #9' },
  ]);
  assert.deepEqual(parseGithubIssues(listed).map((i) => [i.id, i.status, i.depends_on]), [['12', 'open', ['9', '10']], ['9', 'done', []], ['10', 'open', ['9']]]);

  const calls = [];
  const comments = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'list') return listed;
    if (args[1] === 'view' && args.includes('comments')) return comments.join('\n');
    if (args[1] === 'view') return 'OPEN';
    if (args[1] === 'comment') comments.push(args[args.indexOf('--body') + 1]);
    return '';
  };
  const t = githubTracker({}, { gh });
  assert.equal((await t.list()).length, 3);
  assert.equal(await t.update('12', { status: 'done', note: 'merged in abc1234' }), null, 'nothing in the repo changes');
  await t.update('12', { status: 'done', note: 'merged in abc1234' });
  assert.equal(comments.length, 1, 'the same note is posted once');
  assert.equal(calls.filter((c) => c.startsWith('issue close 12')).length, 2, 'closed when still open');
  await t.update('10', { status: 'in_progress' });
  assert.match(comments[1], /^crew: in progress/);
});

test('delivery: local by default; github checks against the remote base branch', () => {
  const local = withConfigDefaults({});
  assert.equal(isGithub(local), false);
  assert.equal(baseRef(local), 'main');
  const github = withConfigDefaults({ baseBranch: 'trunk', delivery: { mode: 'github' } });
  assert.equal(isGithub(github), true);
  assert.equal(baseRef(github), 'origin/trunk');
  assert.equal(github.delivery.prFooter, null, 'no PR attribution unless configured');
  assert.equal(baseRef(withConfigDefaults({ delivery: { mode: 'github', remote: 'upstream' } })), 'upstream/main');
});

test('no role may act on the remote through gh', () => {
  assert.ok(ROLE_TOOLS.coder.disallowed.includes('Bash(gh *)'));
  assert.ok(ROLE_TOOLS.reviewer.disallowed.includes('Bash(gh *)'));
  for (const sub of ['pr', 'issue', 'api', 'repo']) assert.ok(ROLE_TOOLS.triage.disallowed.includes(`Bash(gh ${sub} *)`));
});

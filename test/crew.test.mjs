import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkTransition, fingerprint, identify, isRunning, npmScriptsReferenced, orderingErrors, outOfScope, outputKey, repeated,
  reviewProgress, taskState, withConfigDefaults, withTrailer, ROOT, sumCosts, baseRef, isGithub,
  apiRetryWait, API_RETRY_WAITS_MIN, checkProfile, sandboxAvailable, sandboxedShell, withoutCredentials,
} from '../skill/lib.mjs';
import { shapeErrors, withDefaults } from '../skill/contract.mjs';
import {
  REGISTRY, agentErrors, agentSpecError, agentSpecs, defaultAgents, describeBackends, detectedBackends, ledgerEntry, pairWarnings, parseAgentSpec, runAgent,
} from '../skill/agents/index.mjs';
import { ROLE_TOOLS, callFailure, callShare, callUsage, sandboxSettings } from '../skill/agents/claude.mjs';
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

test('an unsandboxed check must say why', () => {
  const check = (over) => contract({ checks: [{ id: 'AC1', cmd: 'x', expect_exit: 0, ...over }] });
  assert.deepEqual(shapeErrors(check({})), []);
  assert.deepEqual(shapeErrors(check({ unsandboxed: 'drives the iOS simulator' })), []);
  for (const bad of [true, '', '  ']) assert.ok(shapeErrors(check({ unsandboxed: bad })).some((e) => /unsandboxed must say why/.test(e)), JSON.stringify(bad));
});

test('the check profile allows the worktree and temp sockets, and denies secrets, the internet and app launches', () => {
  const profile = checkProfile(ROOT, withConfigDefaults({ secretFiles: ['.env', 'config/*.key'] }));
  const root = realpathSync(ROOT);
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)/);
  assert.ok(profile.includes(`(subpath "${root}")`), 'the worktree is writable');
  assert.ok(profile.includes(`(deny file-write* (literal "${join(root, '.git')}")`), 'its .git pointer is not');
  assert.ok(profile.includes('(regex #"^' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(.*/)?\\.env$")'), 'nested .env');
  assert.ok(profile.includes('/(.*/)?config/[^/]*\\.key$'), 'secret globs match one path segment');
  assert.ok(profile.includes(`(subpath "${join(homedir(), 'Library/Keychains')}")`), 'keychain files');
  for (const rule of ['(global-name-prefix "com.apple.CoreSimulator")', '(deny network*)', '(allow network-outbound (remote ip "localhost:*"))', '(deny lsopen)', '(deny appleevent-send)', 'com.apple.SecurityServer'])
    assert.ok(profile.includes(rule), rule);
  assert.ok(!/unix-socket \(subpath "[^"]*\.docker/.test(profile), 'no Docker socket');
  assert.throws(() => checkProfile(ROOT, withConfigDefaults({ secretFiles: ['a"b'] })), /can't build a sandbox rule/);
});

test('credential-looking environment variables never reach sandboxed commands', () => {
  const env = withoutCredentials({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'x', DB_PASSWORD: 'x', GIT_AUTHOR_NAME: 'me', NODE_ENV: 'test' });
  assert.deepEqual(Object.keys(env).sort(), ['GIT_AUTHOR_NAME', 'HOME', 'NODE_ENV', 'PATH']);
});

// Runs real commands through macOS's sandbox-exec; skipped elsewhere. Every escape tried on 2026-11-12 is here.
test('sandboxed commands keep their exit code and cannot reach secrets, the internet, the git pointer or other apps', { skip: !sandboxAvailable() }, async () => {
  const wt = join(ROOT, '.worktrees', `crew-sbx-${process.pid}`);
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt]);
  const config = withConfigDefaults({});
  const logDir = mkdtempSync(join(tmpdir(), 'crew-sbx-log-'));
  const sh = async (cmd) => (await sandboxedShell(cmd, { worktree: wt, config, cwd: wt, logFile: join(logDir, 'out.log'), timeoutMin: 2 })).code;
  const probe = join(homedir(), `.crew-sandbox-probe-${process.pid}`);
  try {
    assert.equal(await sh('exit 7'), 7);
    assert.equal(await sh('touch inside && test -f inside'), 0, 'the worktree is writable');
    assert.notEqual(await sh(`touch ${probe}`), 0);
    assert.ok(!existsSync(probe), 'nothing written outside the worktree');
    assert.notEqual(await sh('echo "gitdir: /tmp/evil" > .git'), 0, 'the .git pointer is read-only');
    writeFileSync(join(wt, '.env'), 'SECRET=1\n');
    assert.notEqual(await sh('cat .env'), 0, 'secret files are unreadable at any depth');
    if (existsSync(join(homedir(), '.ssh'))) assert.notEqual(await sh('ls ~/.ssh'), 0, 'home credentials are unreadable');
    assert.notEqual(await sh('security find-generic-password -s "Claude Code-credentials" -w >/dev/null'), 0, 'the keychain is unreachable');
    assert.notEqual(await sh('curl -sS -m 5 -o /dev/null https://registry.npmjs.org/'), 0, 'no internet');
    assert.notEqual(await sh('open -g -a TextEdit'), 0, 'no launching apps outside the sandbox');
    assert.notEqual(await sh('xcrun simctl list devices 2>&1 | grep -q "connection became invalid" && exit 1 || exit 0'), 0, 'no simulator');
    const ipc = `node -e "const s=require('net').createServer().listen(require('path').join(require('os').tmpdir(),'crew-'+process.pid+'.sock'),()=>s.close())"`;
    assert.equal(await sh(ipc), 0, 'test runners can open IPC sockets in the temp folder');
    const local = `node -e "const n=require('net');const s=n.createServer((c)=>c.end('ok')).listen(0,'127.0.0.1',()=>n.connect(s.address().port,'127.0.0.1').on('data',(d)=>process.exit(String(d)==='ok'?0:1)).on('error',()=>process.exit(1)))"`;
    assert.equal(await sh(local), 0, 'localhost works (test databases, dev servers)');
    process.env.CREW_TEST_TOKEN = 'leak';
    assert.equal(await sh('test -z "$CREW_TEST_TOKEN"'), 0, 'credential env vars are dropped');
  } finally {
    delete process.env.CREW_TEST_TOKEN;
    execFileSync('git', ['worktree', 'remove', '--force', wt]);
  }
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
  assert.deepEqual(withDefaults({ id: 'T' }).models, { coder: 'claude:haiku', reviewer: 'claude:sonnet' });
  assert.deepEqual(withDefaults({ id: 'T', models: { reviewer: 'opus' } }).models, { coder: 'claude:haiku', reviewer: 'opus' });
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

test('a dropped connection is a transient failure; auth, timeouts and missing output are not', () => {
  // The shape `claude -p` wrote when DNS failed mid-run (2026-11-11): api_error set, subtype still "success".
  const dropped = { type: 'result', subtype: 'success', is_error: true, api_error: 'connection_failed', result: "API Error: Can't reach the API server" };
  assert.deepEqual(callFailure(dropped, false), { failure: 'api error: connection_failed', transient: true });
  for (const e of ['server_error', 'overloaded', 'rate_limit']) assert.equal(callFailure({ ...dropped, api_error: e }, false).transient, true, e);
  assert.deepEqual(callFailure({ ...dropped, api_error: 'authentication_failed' }, false), { failure: 'api error: authentication_failed', transient: false });
  assert.deepEqual(callFailure(null, true), { failure: 'timeout', transient: false });
  assert.deepEqual(callFailure({ subtype: 'error_max_budget_usd', is_error: true }, false), { failure: 'error_max_budget_usd', transient: false });
  assert.deepEqual(callFailure({ subtype: 'success', is_error: false }, false), { failure: 'no structured output', transient: false });
  assert.deepEqual(callFailure({ subtype: 'success', is_error: false, structured_output: { status: 'implemented' } }, false), { failure: null, transient: false });
  assert.equal(callFailure({ is_error: true, structured_output: { status: 'implemented' } }, false).failure, 'no structured output', 'an error result never counts as success');
});

test('transient API failures wait longer each time, about two hours in all, then stop', () => {
  assert.equal(apiRetryWait(0), 60_000);
  const waits = API_RETRY_WAITS_MIN.map((_, i) => apiRetryWait(i));
  waits.slice(1).forEach((w, i) => assert.ok(w > waits[i], 'each wait is longer than the last'));
  const totalMin = waits.reduce((a, b) => a + b, 0) / 60_000;
  assert.ok(totalMin >= 120 && totalMin <= 150, `total ${totalMin} min`);
  assert.equal(apiRetryWait(API_RETRY_WAITS_MIN.length), null);
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

test('the example run and configs in examples/ are valid', async () => {
  const read = (path) => JSON.parse(readFileSync(new URL(`../examples/${path}`, import.meta.url), 'utf8'));
  const raw = read('runs/20260101-truncate-titles/contracts/WEB-TITLE-1.json');
  const batch = read(`runs/20260101-truncate-titles/batches/${raw.batch}.json`);
  for (const mode of ['local', 'github']) {
    const config = withConfigDefaults(read(`${mode}/crew.config.json`));
    assert.deepEqual(shapeErrors(withDefaults(raw), { branchPrefix: config.branchPrefix, lockNames: Object.keys(config.locks) }), [], mode);
  }
  assert.ok(batch.tasks.includes(raw.id));
  const issues = parseJsonIssues(readFileSync(new URL('../examples/local/issues.json', import.meta.url), 'utf8')).map(normalizeIssue);
  assert.deepEqual(issueErrors(issues), []);
  assert.ok(issues.some((i) => i.id === raw.issue));
});

// A fake backend: nothing is spawned. `calls` records what runAgent handed it.
const fakeBackend = (id, { models = [{ id: 'small', tier: 0 }, { id: 'big', tier: 1 }], installed = true, result = {}, ...extra } = {}) => {
  const calls = [];
  const profile = {
    id, roles: ['coder', 'reviewer', 'triage'], models, recommended: { coder: models[0].id, reviewer: models.at(-1).id, triage: models.at(-1).id },
    detect: () => installed, call: async (opts) => { calls.push(opts); return { ok: true, output: { status: 'implemented' }, cost: 0.25, session: 's1', failure: null, transient: false, tokens: { input: 1 }, session_total: { cost: 0.25 }, ...result }; },
    ...extra,
  };
  return { profile, calls };
};

test('an agent is cli:model, a bare model is a claude model, and anything unknown is refused with the way out', () => {
  assert.deepEqual(parseAgentSpec('claude:haiku'), { cli: 'claude', model: 'haiku' });
  assert.deepEqual(parseAgentSpec('opus'), { cli: 'claude', model: 'opus' });
  assert.throws(() => parseAgentSpec('codex:gpt-5-codex'), /unknown agent cli "codex" \(available: claude\)/);
  assert.throws(() => parseAgentSpec('claude:gpt-5'), /unknown model "gpt-5" for claude \(available: haiku, sonnet, opus/);
  assert.throws(() => parseAgentSpec('gpt-5'), /unknown model "gpt-5" for claude.*"cli:model" picks another backend/);
  for (const bad of ['', '  ', null, undefined, 3, 'claude:', ':haiku', '__proto__:x', 'constructor:x']) assert.throws(() => parseAgentSpec(bad), Error, String(bad));
  // the model after the first colon is kept whole, and a backend can opt into free-form model ids
  const { profile } = fakeBackend('open', { freeFormModels: true });
  const registry = { open: profile };
  assert.deepEqual(parseAgentSpec('open:llama3:8b', registry), { cli: 'open', model: 'llama3:8b' });
  assert.throws(() => parseAgentSpec('open:x; rm -rf ~', registry), /bad model id/);
  assert.throws(() => parseAgentSpec('open:', registry), /bad model id/);
});

test('agents default to the registry\'s recommendations, and the config overrides one role at a time', () => {
  assert.deepEqual(defaultAgents(), { coder: 'claude:haiku', reviewer: 'claude:sonnet', triage: 'claude:sonnet' });
  assert.deepEqual(agentSpecs({}), defaultAgents());
  assert.deepEqual(agentSpecs({ agents: { reviewer: 'opus' } }), { coder: 'claude:haiku', reviewer: 'opus', triage: 'claude:sonnet' });
  assert.deepEqual(agentErrors({}), []);
  assert.deepEqual(agentErrors({ agents: { coder: 'claude:haiku', reviewer: 'sonnet' } }), []);
  const errors = agentErrors({ agents: { coder: 'codex:x', reviewer: 'gpt', planner: 'opus' } });
  for (const re of [/agents\.coder: unknown agent cli "codex"/, /agents\.reviewer: unknown model "gpt"/, /agents\.planner: unknown role/]) assert.ok(errors.some((e) => re.test(e)), String(re));
  assert.match(agentErrors({ agents: 'opus' })[0], /must be an object/);
});

test('a contract\'s models override the config per task, accept cli:model, and are validated against the registry', () => {
  const agents = { coder: 'claude:sonnet', reviewer: 'claude:opus', triage: 'claude:sonnet' };
  assert.deepEqual(withDefaults({ id: 'T' }, agents).models, { coder: 'claude:sonnet', reviewer: 'claude:opus' });
  assert.deepEqual(withDefaults({ id: 'T', models: { coder: 'haiku' } }, agents).models, { coder: 'haiku', reviewer: 'claude:opus' });
  assert.deepEqual(shapeErrors(contract({ models: { coder: 'claude:haiku', reviewer: 'sonnet' } })), []);
  const errors = shapeErrors(contract({ models: { coder: 'codex:gpt-5-codex', reviewer: 'gpt-5', triage: 'sonnet' } }));
  for (const re of [/models\.coder: unknown agent cli "codex"/, /models\.reviewer: unknown model "gpt-5"/, /models takes only coder and reviewer/]) assert.ok(errors.some((e) => re.test(e)), String(re));
  // a registered backend makes its specs valid
  const { profile } = fakeBackend('codex');
  assert.deepEqual(shapeErrors(contract({ models: { coder: 'claude:haiku', reviewer: 'codex:big' } }), { registry: { ...REGISTRY, codex: profile } }), []);
  assert.match(agentSpecError('codex:big', 'coder', { codex: { ...profile, roles: ['reviewer'] } }), /codex can't run the coder role/);
});

test('model warnings rank by tier, only inside one backend, and stay silent about families with one backend', () => {
  const security = /auth/i;
  const c = (coder, reviewer, file = 'src/auth/login.ts') => ({ id: 'T', models: { coder, reviewer }, allowed_files: [{ path: file, op: 'edit' }] });
  assert.deepEqual(pairWarnings(c('claude:haiku', 'claude:sonnet'), security), [], 'the default pair is quiet');
  assert.match(pairWarnings(c('sonnet', 'haiku'), security)[0], /reviewer \(claude:haiku\) is weaker than the coder \(claude:sonnet\)/);
  assert.match(pairWarnings(c('sonnet', 'claude:sonnet'), security)[0], /both claude:sonnet/);
  assert.match(pairWarnings(c('haiku', 'opus', 'src/ui/button.ts'), security)[0], /claude:opus reviewer on files that don't look security.*sonnet is the default/);
  assert.deepEqual(pairWarnings(c('haiku', 'opus'), security), [], 'opus on security-shaped files is what it is for');

  const small = fakeBackend('small-cli', { models: [{ id: 'a', tier: 0 }, { id: 'b', tier: 5 }] }).profile;
  const other = fakeBackend('other', { installed: false }).profile;
  const registry = { claude: REGISTRY.claude, 'small-cli': small, other };
  // tiers of different backends aren't comparable: claude:opus coding for small-cli:a is not "weaker"
  assert.deepEqual(pairWarnings(c('claude:opus', 'small-cli:a'), security, { registry, installed: [] }), []);
  // same backend twice while another installed one could review → the family warning, not for a missing CLI
  const family = pairWarnings(c('claude:haiku', 'claude:sonnet'), security, { registry, installed: ['claude', 'small-cli'] });
  assert.equal(family.length, 1);
  assert.match(family[0], /both run on claude, and small-cli is installed; a reviewer from a different model family catches correlated mistakes/);
  assert.deepEqual(pairWarnings(c('claude:haiku', 'small-cli:a'), security, { registry, installed: ['claude', 'small-cli'] }), [], 'already a different family');
  assert.deepEqual(detectedBackends(), [], 'one backend registered: nothing to detect, nothing to say');
  assert.deepEqual(detectedBackends(registry), ['claude', 'small-cli'].filter((id) => registry[id].detect()), 'only installed ones');
  assert.ok(!detectedBackends(registry).includes('other'));
});

test('runAgent hands the role, model and schema to the named backend and returns the common result', async () => {
  const { profile, calls } = fakeBackend('fake');
  const registry = { fake: profile };
  const r = await runAgent({ role: 'reviewer', agent: { cli: 'fake', model: 'big' }, registry, prompt: 'p', budget: 2, timeoutMin: 5, cwd: '/w', logFile: '/l' });
  assert.deepEqual(r, { ok: true, output: { status: 'implemented' }, cost: 0.25, session: 's1', failure: null, transient: false }, 'no backend-specific fields leak');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'big');
  assert.equal(calls[0].role, 'reviewer');
  assert.equal(calls[0].schema.required[0], 'verdict', 'the role\'s neutral schema');
  assert.equal(calls[0].prompt, 'p');
  assert.equal(calls[0].budget, 2);
  // failures pass through unchanged
  const failing = fakeBackend('bad', { result: { ok: false, output: null, failure: 'api error: overloaded', transient: true } });
  const f = await runAgent({ role: 'coder', agent: { cli: 'bad', model: 'small' }, registry: { bad: failing.profile } });
  assert.deepEqual([f.ok, f.failure, f.transient], [false, 'api error: overloaded', true]);
});

test('runAgent refuses what no backend can run, before spawning anything', async () => {
  const { profile, calls } = fakeBackend('fake', { roles: ['reviewer'] });
  const registry = { fake: profile };
  await assert.rejects(runAgent({ role: 'coder', agent: { cli: 'fake', model: 'small' }, registry }), /fake can't run the coder role/);
  await assert.rejects(runAgent({ role: 'reviewer', agent: { cli: 'nope', model: 'small' }, registry }), /unknown agent cli "nope"/);
  await assert.rejects(runAgent({ role: 'reviewer', agent: { cli: 'fake', model: 'huge' }, registry }), /unknown model "huge" for fake/);
  await assert.rejects(runAgent({ role: 'reviewer', agent: { cli: 'constructor', model: 'x' }, registry }), /unknown agent cli/);
  assert.equal(calls.length, 0);
  // a backend that throws is not swallowed
  const boom = fakeBackend('boom', { call: async () => { throw new Error('spawn failed'); } });
  await assert.rejects(runAgent({ role: 'coder', agent: { cli: 'boom', model: 'small' }, registry: { boom: boom.profile } }), /spawn failed/);
});

test('the cost ledger entry records which cli ran, besides role, model, session and the call\'s own share', () => {
  const entry = ledgerEntry({ run: 'r', task: 'T', round: 1, version: 1 }, { cli: 'codex', model: 'gpt-5-codex', role: 'coder', resume: 'abc' }, { session: 's2', cost: 0.5, tokens: { input: 3 }, session_total: { cost: 1 } });
  assert.deepEqual(entry, { run: 'r', task: 'T', round: 1, version: 1, cli: 'codex', role: 'coder', model: 'gpt-5-codex', resumed: true, session: 's2', cost: 0.5, tokens: { input: 3 }, session_total: { cost: 1 } });
  assert.equal(ledgerEntry({}, { cli: 'claude', model: 'haiku', role: 'coder', resume: null }, {}).resumed, false);
});

test('the backend report lists models with tiers and per-role recommendations, and flags missing CLIs', () => {
  const [claude] = describeBackends();
  assert.equal(claude.id, 'claude');
  assert.deepEqual(claude.models.map((m) => [m.id, m.tier, m.recommended_for]), [['haiku', 0, ['coder']], ['sonnet', 1, ['reviewer', 'triage']], ['opus', 2, []]]);
  assert.equal(typeof claude.detected, 'boolean');
  const missing = describeBackends({ gone: fakeBackend('gone', { installed: false }).profile });
  assert.equal(missing[0].detected, false);
});

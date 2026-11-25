// The Claude Code backend: every role is a `claude -p` call with the role prompt appended to the system prompt, a JSON
// schema for the output, a tool allowlist and (coder, reviewer) Claude Code's OS sandbox. Everything that reads
// Claude's settings, flags or stream-json result lives here; the rest of the crew only sees the profile.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME_SECRETS, ROOT, SKILL, cfg, git, readCosts, run } from '../lib.mjs';

const GIT_WRITES = ['commit', 'push', 'reset', 'checkout', 'switch', 'rebase', 'merge', 'stash', 'clean', 'restore', 'worktree', 'branch', 'tag'];
export const ROLE_TOOLS = {
  // No role may use gh to act on the remote: pushes, PRs and issue updates belong to the driver and `crew merge`.
  coder: { tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], disallowed: [...GIT_WRITES.filter((c) => c !== 'restore').map((c) => `Bash(git ${c} *)`), 'Bash(gh *)'] },
  reviewer: { tools: ['Read', 'Bash', 'Grep', 'Glob'], disallowed: [...[...GIT_WRITES, 'add', 'rm', 'mv', 'apply'].map((c) => `Bash(git ${c} *)`), 'Bash(gh *)'] },
  triage: { tools: ['Read', 'Bash', 'Grep', 'Glob'], disallowed: [...[...GIT_WRITES, 'add', 'rm'].map((c) => `Bash(git ${c} *)`), 'Bash(gh pr *)', 'Bash(gh issue *)', 'Bash(gh api *)', 'Bash(gh repo *)'] },
};

// OS sandbox for coder and reviewer (Claude Code `sandbox` settings, passed per call with --settings). Bash and
// everything it spawns may write only to the worktree, its git admin dir, temp and caches, may not read credentials,
// and may reach only the config's allowed domains and localhost. It fails closed: no unsandboxed fallback, and no run
// at all when the sandbox is unavailable. Read/Edit/Write are not sandboxed by the OS, so permission deny rules
// cover them: no secrets, and no edits to the main checkout (including the crew's own state) or home dotfiles.
export function sandboxSettings(worktree, config = cfg()) {
  const home = homedir();
  const gitDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir');
  // Every top-level entry of the main checkout except the worktree folder is protected. Entries are listed rather
  // than globbed: a gitignore-style `*` would also match the worktree folder and everything in it.
  const worktreeTop = config.worktreeDir.split('/')[0];
  const mainEntries = readdirSync(ROOT).filter((e) => e !== worktreeTop);
  return {
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
      filesystem: {
        allowWrite: [worktree, gitDir, tmpdir(), '/tmp', '/private/tmp', join(home, '.npm'), join(home, '.cache'), join(home, 'Library/Caches')],
        denyRead: [...HOME_SECRETS.map((p) => join(home, p)), ...config.secretFiles.filter((f) => !/[*?]/.test(f)).map((f) => join(ROOT, f))],
      },
      network: { allowedDomains: config.network.allowedDomains, allowLocalBinding: true, strictAllowlist: true },
    },
    permissions: {
      deny: [
        ...HOME_SECRETS.flatMap((p) => [`Read(~/${p})`, `Read(~/${p}/**)`]),
        ...config.secretFiles.map((f) => `Read(/${ROOT}/**/${f})`),
        ...mainEntries.flatMap((e) => [`Edit(/${ROOT}/${e})`, `Edit(/${ROOT}/${e}/**)`]),
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

// A resumed session reports cost and tokens for the whole session so far (measured 2026-11-05), so a call's own share
// is the difference from that session's last ledger entry.
export function callShare(total, prior) {
  if (!prior) return total;
  const tokens = Object.fromEntries(Object.entries(total.tokens).map(([k, v]) => [k, Math.max(0, v - (prior.tokens?.[k] ?? 0))]));
  return { cost: Math.max(0, total.cost - prior.cost), tokens };
}

// The CLI reports an unreachable, overloaded or rate-limited API as a result with `api_error` set (and, measured
// 2026-11-12, subtype "success"), so it used to read as "no structured output". Only these pass on their own; any
// other api_error (authentication, billing, a bad request) is a real failure and is never waited out.
export const TRANSIENT_API_ERRORS = new Set(['connection_failed', 'server_error', 'overloaded', 'rate_limit']);
export function callFailure(result, timedOut) {
  if (result?.structured_output && !result.is_error) return { failure: null, transient: false };
  if (timedOut) return { failure: 'timeout', transient: false };
  const apiError = result?.api_error ?? null;
  if (apiError) return { failure: `api error: ${apiError}`, transient: TRANSIENT_API_ERRORS.has(apiError) };
  if (result?.subtype && result.subtype !== 'success') return { failure: result.subtype, transient: false };
  return { failure: 'no structured output', transient: false };
}

// Runs one role as a `claude -p` call. `--agent` is not used: it drops structured output. Besides the common result
// it returns `tokens` and `session_total`, which runAgent writes to the cost ledger.
async function call({ role, model, prompt, schema, budget, timeoutMin, cwd, logFile, onSpawn, resume = null, ledger = null }) {
  if (resume && !ledger) throw new Error('a resumed call needs the ledger to separate its cost from the session total');
  const { tools, disallowed } = ROLE_TOOLS[role];
  const prior = resume ? readCosts(ledger.run).findLast((e) => e.session === resume)?.session_total ?? null : null;
  // The cap stays per call even if the CLI applies it to the session total.
  const cap = budget + (prior?.cost ?? 0);
  // --strict-mcp-config with no --mcp-config: no MCP servers, so the role sees only the tools listed here.
  const args = ['-p', '--model', model, '--permission-mode', 'auto', '--max-budget-usd', String(cap), '--strict-mcp-config',
    '--append-system-prompt-file', join(SKILL, 'prompts', `${role}.md`),
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema),
    '--tools', tools.join(','), '--disallowedTools', disallowed.join(','),
    ...(SHARED_PREFIX ? ['--exclude-dynamic-system-prompt-sections'] : []),
    ...(resume ? ['--resume', resume] : []),
    ...(role === 'triage' ? [] : ['--settings', JSON.stringify(sandboxSettings(cwd))])];
  const env = CACHE_1H ? { ENABLE_PROMPT_CACHING_1H: '1' } : undefined;
  const r = await run('claude', args, { cwd, input: prompt, logFile, timeoutMin, onSpawn, env });
  const result = lastResult(logFile);
  const total = { cost: result?.total_cost_usd ?? 0, tokens: callUsage(result) };
  const { cost, tokens } = callShare(total, prior);
  const { failure, transient } = callFailure(result, r.timedOut);
  return { ok: failure === null, output: result?.structured_output ?? null, cost, session: result?.session_id ?? null, failure, transient, tokens, session_total: total };
}

export const claude = {
  id: 'claude',
  roles: ['coder', 'reviewer', 'triage'],
  // tier: relative strength within this backend, used to warn about a reviewer no stronger than its coder.
  models: [{ id: 'haiku', tier: 0 }, { id: 'sonnet', tier: 1 }, { id: 'opus', tier: 2 }],
  recommended: { coder: 'haiku', reviewer: 'sonnet', triage: 'sonnet' },
  detect: () => spawnSync('claude', ['--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0,
  call,
};

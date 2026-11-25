// The machine half of a contract (`contracts/<id>.json`; the `.md` beside it is the prose the coder and reviewer read):
// defaults, loading and the shape check. See references/contract-json.md.
import { CONFIG_DEFAULTS, cfg, contractPath, readJson } from './lib.mjs';
import { agentSpecError, agentSpecs, defaultAgents } from './agents/index.mjs';

export const DEFAULTS = {
  depends_on: [], setup: [], checks: [], gates: [], locks: [], docs: [], max_rounds: 3,
  close_issue: true, manual_acceptance: null,
  budget_usd: { coder: 5, reviewer: 2, triage: 1 },
  timeout_min: { setup: 20, coder: 45, reviewer: 20, checks: 30, ci: 45 },
};
// `models` is each role's "cli:model" for this task: the contract's own, else the project's `agents` (see agents/).
export function withDefaults(raw, agents = defaultAgents()) {
  const c = { ...DEFAULTS, ...raw };
  c.models = { coder: agents.coder, reviewer: agents.reviewer, ...raw.models };
  c.budget_usd = { ...DEFAULTS.budget_usd, ...raw.budget_usd };
  c.timeout_min = { ...DEFAULTS.timeout_min, ...raw.timeout_min };
  c.checks = c.checks.map((ch) => ({ locks: [], ...ch }));
  // Manual acceptance or close_issue: false keeps the issue open after the merge (state needs_human).
  c.keep_open = Boolean(c.manual_acceptance) || c.close_issue === false;
  return c;
}
export const loadContract = (run, id) => withDefaults(readJson(contractPath(run, id)), agentSpecs(cfg()));

// Pure shape check of one contract; returns error strings.
export function shapeErrors(c, { dryRun = false, branchPrefix = CONFIG_DEFAULTS.branchPrefix, lockNames = [], registry } = {}) {
  const errors = [];
  const need = (ok, msg) => { if (!ok) errors.push(`${c.id ?? '?'}: ${msg}`); };
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  const prefix = branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  need(str(c.id) && /^[A-Za-z0-9._-]+$/.test(c.id), 'id must be letters, digits, dot, dash or underscore');
  need(Number.isInteger(c.version) && c.version >= 1, 'version must be an integer ≥ 1');
  need(str(String(c.issue ?? '')) || dryRun, 'issue must name an issue id from the project issue file');
  for (const k of ['title', 'batch', 'commit', 'summary']) need(str(c[k]), `${k} missing`);
  need(str(c.branch) && new RegExp(`^${prefix}[A-Za-z0-9._/-]+$`).test(c.branch), `branch must start with ${branchPrefix}`);
  for (const role of ['coder', 'reviewer']) {
    const problem = agentSpecError(c.models?.[role], role, registry);
    need(!problem, `models.${role}: ${problem}`);
  }
  need(Object.keys(c.models ?? {}).every((k) => k === 'coder' || k === 'reviewer'), 'models takes only coder and reviewer (triage is set in crew.config.json "agents")');
  need(Array.isArray(c.allowed_files) && c.allowed_files.length > 0, 'allowed_files is empty');
  for (const f of c.allowed_files ?? []) need(str(f.path) && ['edit', 'create', 'delete'].includes(f.op), `bad allowed_files entry ${JSON.stringify(f)}`);
  for (const ch of c.checks) need(str(ch.id) && str(ch.cmd) && Number.isInteger(ch.expect_exit), `bad check ${JSON.stringify(ch)}`);
  for (const ch of c.checks) need(ch.unsandboxed === undefined || str(ch.unsandboxed), `check ${ch.id}: unsandboxed must say why the check can't run in the sandbox`);
  need(c.checks.length + c.gates.length > 0, 'no checks or gates: nothing deterministic proves the change');
  for (const g of [...c.gates, ...c.setup]) need(str(g), 'empty gate/setup command');
  for (const l of [...c.locks, ...c.checks.flatMap((ch) => ch.locks)]) need(lockNames.includes(l), `unknown lock ${l} (declare it in crew.config.json "locks")`);
  need(Number.isInteger(c.max_rounds) && c.max_rounds >= 1 && c.max_rounds <= 5, 'max_rounds must be 1–5');
  for (const [k, v] of Object.entries(c.budget_usd)) need(typeof v === 'number' && v > 0, `budget_usd.${k} must be > 0`);
  for (const [k, v] of Object.entries(c.timeout_min)) need(typeof v === 'number' && v > 0, `timeout_min.${k} must be > 0`);
  need(typeof c.close_issue === 'boolean', 'close_issue must be true or false');
  for (const d of c.docs) need(str(d.file) && str(d.find) && typeof d.replace === 'string', `bad docs entry for ${d.file}`);
  return errors;
}

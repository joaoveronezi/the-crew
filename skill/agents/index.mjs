// Agent backends: who runs a role (coder, reviewer, triage). The boss is the user's own Claude Code session and is not
// pluggable. A backend is a profile:
//   { id, roles, models: [{ id, tier }], recommended: { role: modelId }, detect(), call(opts), freeFormModels? }
// `tier` ranks a backend's models by strength (comparable only inside one backend). `call` returns
// { ok, output, cost, session, failure, transient, tokens?, session_total? }; runAgent writes the cost ledger once, for
// every backend. An agent is named "cli:model" (e.g. "claude:haiku"); a bare model means a claude model.
import { SCHEMAS, recordCost } from '../lib.mjs';
import { claude } from './claude.mjs';

export const ROLES = ['coder', 'reviewer', 'triage'];
export const DEFAULT_CLI = 'claude';
export const REGISTRY = { [claude.id]: claude };

const profileOf = (cli, registry) => (Object.hasOwn(registry, cli) ? registry[cli] : null);
const list = (items) => items.join(', ');

// The reason an agent ({ cli, model }) can't be used, or null. Model ids reach a command line, so a backend that
// accepts any model (freeFormModels) still gets them checked for shape; claude stays strict.
function agentProblem({ cli, model }, registry) {
  const profile = profileOf(cli, registry);
  if (!profile) return `unknown agent cli "${cli}" (available: ${list(Object.keys(registry))})`;
  if (profile.freeFormModels) return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model) ? null : `bad model id "${model}" for ${cli}`;
  if (!profile.models.some((m) => m.id === model)) return `unknown model "${model}" for ${cli} (available: ${list(profile.models.map((m) => m.id))}${cli === DEFAULT_CLI ? `; "cli:model" picks another backend` : ''})`;
  return null;
}
const roleProblem = (role, { cli }, registry) => (profileOf(cli, registry)?.roles.includes(role) ? null : `${cli} can't run the ${role} role`);

// "cli:model" → { cli, model }; a bare model is a claude model (how configs and contracts were written before backends
// were pluggable). Throws a message that says what to write instead.
export function parseAgentSpec(spec, registry = REGISTRY) {
  if (typeof spec !== 'string' || spec.trim() === '') throw new Error(`an agent is a "cli:model" string, not ${JSON.stringify(spec)}`);
  const colon = spec.indexOf(':');
  const agent = colon < 0 ? { cli: DEFAULT_CLI, model: spec } : { cli: spec.slice(0, colon), model: spec.slice(colon + 1) };
  const problem = agentProblem(agent, registry);
  if (problem) throw new Error(problem);
  return agent;
}
export const formatAgent = ({ cli, model }) => `${cli}:${model}`;

// Why `spec` can't run `role`, or null. Used wherever a spec comes from a file (config, contract).
export function agentSpecError(spec, role, registry = REGISTRY) {
  try { return roleProblem(role, parseAgentSpec(spec, registry), registry); } catch (e) { return e.message; }
}

// What each role runs when nothing says otherwise: the default backend's recommendations.
export const defaultAgents = (registry = REGISTRY) => Object.fromEntries(ROLES.map((r) => [r, formatAgent({ cli: DEFAULT_CLI, model: registry[DEFAULT_CLI].recommended[r] })]));
// The config's `agents` over the defaults: one spec string per role.
export const agentSpecs = (config, registry = REGISTRY) => ({ ...defaultAgents(registry), ...config.agents });
export function agentErrors(config, registry = REGISTRY) {
  const agents = config.agents ?? {};
  if (typeof agents !== 'object' || Array.isArray(agents)) return [`agents must be an object with ${list(ROLES)}`];
  return Object.entries(agents).flatMap(([role, spec]) => {
    if (!ROLES.includes(role)) return [`agents.${role}: unknown role (use ${list(ROLES)})`];
    const problem = agentSpecError(spec, role, registry);
    return problem ? [`agents.${role}: ${problem}`] : [];
  });
}

// What /crew adapt needs for its menus: each backend, whether its CLI is installed, and its models with their tier
// and the roles they are recommended for.
export const describeBackends = (registry = REGISTRY) => Object.values(registry).map((p) => ({
  id: p.id, detected: Boolean(p.detect()), roles: p.roles, free_form_models: Boolean(p.freeFormModels),
  models: p.models.map((m) => ({ id: m.id, tier: m.tier, recommended_for: ROLES.filter((r) => p.recommended[r] === m.id) })),
}));

// Backends other than the first that are installed. With one backend registered there is nothing to detect.
export const detectedBackends = (registry = REGISTRY) => (Object.keys(registry).length > 1 ? Object.values(registry).filter((p) => p.detect()).map((p) => p.id) : []);

const tierOf = (agent, registry) => profileOf(agent.cli, registry).models.find((m) => m.id === agent.model)?.tier;

// Not errors, but worth a second look at one contract's coder/reviewer pair: a reviewer no stronger than its coder, an
// expensive top-tier reviewer where nothing looks security-shaped, and a reviewer from the coder's own backend when
// another installed one could review. Tiers only compare inside one backend.
export function pairWarnings(c, security, { registry = REGISTRY, installed = detectedBackends(registry) } = {}) {
  const coder = parseAgentSpec(c.models.coder, registry);
  const reviewer = parseAgentSpec(c.models.reviewer, registry);
  const [coderTier, reviewerTier] = [tierOf(coder, registry), tierOf(reviewer, registry)];
  const comparable = coder.cli === reviewer.cli && coderTier !== undefined && reviewerTier !== undefined;
  const profile = profileOf(reviewer.cli, registry);
  const top = reviewerTier !== undefined && reviewerTier === Math.max(...profile.models.map((m) => m.tier ?? -1)) && profile.models.length > 1;
  const out = [];
  if (comparable && reviewerTier < coderTier) out.push(`${c.id}: reviewer (${formatAgent(reviewer)}) is weaker than the coder (${formatAgent(coder)})`);
  else if (comparable && reviewerTier === coderTier) out.push(`${c.id}: coder and reviewer are both ${formatAgent(coder)}; use a stronger reviewer for security, auth or data work`);
  // A top-tier review is usually the most expensive call in a run; the default reviewer is cheaper.
  else if (top && !c.allowed_files.some((f) => security.test(f.path))) out.push(`${c.id}: ${formatAgent(reviewer)} reviewer on files that don't look security, auth or data shaped (securityPaths); ${profile.recommended.reviewer} is the default`);
  const others = installed.filter((id) => id !== coder.cli && profileOf(id, registry)?.roles.includes('reviewer'));
  if (coder.cli === reviewer.cli && others.length) out.push(`${c.id}: coder and reviewer both run on ${coder.cli}, and ${list(others)} is installed; a reviewer from a different model family catches correlated mistakes`);
  return out;
}

// One ledger line per call: the caller's ledger fields plus which backend, role and model ran.
export const ledgerEntry = (ledger, { cli, role, model, resume }, r) =>
  ({ ...ledger, cli, role, model, resumed: Boolean(resume), session: r.session, cost: r.cost, tokens: r.tokens, session_total: r.session_total });

// Runs a role on the backend `agent` names. Same result for every backend:
// { ok, output, cost, session, failure, transient }. Throws before spawning anything if the agent can't take the role.
export async function runAgent({ role, agent, registry = REGISTRY, schema = SCHEMAS[role], resume = null, ledger = null, ...call }) {
  const problem = agentProblem(agent, registry) ?? roleProblem(role, agent, registry);
  if (problem) throw new Error(problem);
  const r = await registry[agent.cli].call({ ...call, role, model: agent.model, schema, resume, ledger });
  if (ledger) recordCost(ledger.run, ledgerEntry(ledger, { ...agent, role, resume }, r));
  return { ok: r.ok, output: r.output, cost: r.cost, session: r.session, failure: r.failure, transient: r.transient };
}

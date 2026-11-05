# Configuration

The crew works without any configuration. To change its defaults, add a `crew.config.json` at the root of the repository you run it in. Every field is optional.

```json
{
  "remote": "origin",
  "main_branch": "main",
  "branch_prefix": "agent/",
  "run_dir": ".claude/loops",
  "worktree_dir": ".worktrees",
  "locks": ["e2e", "db"],
  "ordering_paths": ["(^|/)package(-lock)?\\.json$", "(^|/)(pnpm-lock\\.yaml|yarn\\.lock)$", "(^|/)migrations?/"],
  "security_paths": "auth|session|token|secret|security|crypto|password|permission|migration",
  "docs_check": null,
  "commit_trailer": null,
  "pr_footer": null,
  "sandbox": {
    "allowed_domains": ["registry.npmjs.org"],
    "extra_write": []
  }
}
```

| field | default | what it does |
| --- | --- | --- |
| `remote` | `origin` | Remote that branches are pushed to and fetched from |
| `main_branch` | `main` | Branch that task branches start from, merge into and are validated against |
| `branch_prefix` | `agent/` | Every contract's `branch` must start with it. The wrapup docs branch uses it too |
| `run_dir` | `.claude/loops` | Where runs live, relative to the repo root. Gitignore it |
| `worktree_dir` | `.worktrees` | Where task worktrees are created. Gitignore it. The sandbox protects every other top-level entry of the repo |
| `locks` | `["e2e", "db"]` | Lock names contracts may use. `e2e` serializes the contracts' `e2e` commands across drivers. Any other lock is held during the coder call and the checks, for resources such as a shared test database |
| `ordering_paths` | lockfiles, migrations | Regexes. Two tasks that both touch a matching path in the same top-level directory must be ordered with `depends_on`, even if they change different files. Add your API contract (e.g. `"openapi\\.json$"`) or schema files |
| `security_paths` | see above | Regex, case-insensitive. `validate` warns when an Opus reviewer is used on a task whose allowed files match none of it |
| `docs_check` | `null` | Command that `crew wrapup` runs before opening the docs PR, e.g. `"npm run check:docs"` |
| `commit_trailer` | `null` | Text appended to every crew commit message, e.g. a `Co-Authored-By:` line. Nothing is added by default |
| `pr_footer` | `null` | Text appended to every crew PR body. Nothing is added by default |
| `sandbox.allowed_domains` | `["registry.npmjs.org"]` | The only hosts that coder and reviewer Bash may reach, besides localhost. Add your package registries (e.g. `pypi.org`, `files.pythonhosted.org`) |
| `sandbox.extra_write` | `[]` | Extra absolute paths that coder and reviewer Bash may write to, e.g. a tool's cache directory |

## Environment switches

These turn off one cost optimization for a run. Set them in the environment of `crew start`; the orchestrator passes them on to its drivers.

| variable | effect when `0` |
| --- | --- |
| `CREW_SHARED_PREFIX` | Don't pass `--exclude-dynamic-system-prompt-sections`. Each worktree then caches its own system prompt |
| `CREW_CACHE_1H` | Don't request the 1-hour prompt-cache TTL. The default 5-minute TTL applies |
| `CREW_CODER_RESUME` | Start a fresh coder session every round instead of resuming |

`CREW_ROOT` points the crew at a repository other than the current directory.

## Batches

`batches/<batch>.json` in the run directory:

```json
{ "tasks": ["WEB-TITLE-001", "WEB-TITLE-002"], "max_parallel": 2, "dry_run": false }
```

- `max_parallel` bounds how many drivers run at once in the batch. Each driver can run builds and tests, so this is also your machine-load limit.
- `dry_run: true` skips the issue claim, push, PR and CI, and stops at `ready_to_merge` with no PR. Use it to rehearse contracts.

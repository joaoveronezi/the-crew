# Configuration

Each project has a `.claude/crew.config.json`, written by `/crew adapt` and committed with the project. Every field is optional. The full field reference, which is also what the boss reads, is [`skill/references/config.md`](../skill/references/config.md). This page covers the choices you're most likely to make.

## Where issues come from

```jsonc
{ "issues": { "file": "issues.json" } }              // or "issues/", or "issues.md"
{ "issues": { "github": true } }                      // GitHub Issues of this repo, via gh
{ "issues": { "github": { "repo": "owner/name" } } }  // another repo's issues
{ "issues": { "file": "TODO.md", "adapter": ".claude/crew/issues-adapter.mjs" } }  // anything else
{ "issues": { "file": "export.csv", "adapter": "…", "writeBack": false } }         // read-only source
```

Formats and the adapter contract: [issue sources](../skill/references/issues.md). The adapter template is [`skill/templates/issues-adapter.mjs`](../skill/templates/issues-adapter.mjs).

## How approved work is delivered

```jsonc
{ "delivery": { "mode": "local" } }                    // default: squash-merge on this machine
{ "delivery": { "mode": "github", "remote": "origin" } }  // push, PR, CI, merge the PR through gh
```

See [delivery](how-it-works.md#delivery-local-or-pull-requests). In github mode, `gh` must be authenticated, and the repository needs CI on pull requests: the crew treats green checks as a merge requirement.

## Attribution

Nothing is added to crew commits or PRs by default. To add a line:

```json
{ "commitTrailer": "Co-Authored-By: …", "delivery": { "mode": "github", "prFooter": "…" } }
```

## Shared resources and parallel safety

```json
{
  "locks": { "db": "the local database used by integration tests", "sim": "the iOS simulator" },
  "sensitivePaths": ["(^|/)package-lock\\.json$", "^db/migrations/", "(^|/)openapi\\.json$"]
}
```

- **`locks`:** only one task at a time may hold a lock. A contract names the locks for the whole task, and each check names the ones it needs.
- **`sensitivePaths`:** regexes. Two tasks that both touch one of them must be ordered with `depends_on`, even if they change different files. `crew validate` enforces it.

## Sandbox

```json
{ "secretFiles": [".env", ".env.local"], "network": { "allowedDomains": ["registry.npmjs.org", "pypi.org"] } }
```

- **`secretFiles`:** paths, at any depth, that coders and reviewers can never read.
- **`network.allowedDomains`:** the only hosts their commands may reach, besides localhost.

See [security](security.md).

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
{ "tasks": ["WEB-TITLE-1", "WEB-SORT-1"], "max_parallel": 2, "dry_run": false }
```

- `max_parallel` bounds how many drivers run at once in the batch. Each driver can run builds and tests, so this is also your machine-load limit.
- `dry_run: true` (what `/crew rehearse` sets) runs real coder/reviewer rounds, but the task is never merged, pushed or turned into a PR, and issue statuses don't change. Use it to rehearse contracts.

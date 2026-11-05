# Security model

The crew runs code-writing models unattended. Their limits are enforced by the CLI and the operating system, not by asking politely in a prompt.

## What each role can do

| role | tools | sandbox | can't |
| --- | --- | --- | --- |
| coder | Read, Edit, Write, Bash, Grep, Glob | OS sandbox | commit, push, reset, branch, merge, stash or other git writes (`git restore` is allowed); any `gh`; MCP servers |
| reviewer | Read, Bash, Grep, Glob | OS sandbox | any git write, `git add/rm/mv/apply`; any `gh`; MCP servers. Anything it leaves in the worktree is reset |
| triage | Read, Bash, Grep, Glob | none (it may need to start a database or stop a stray process) | git writes, `git add/rm`; `gh pr`, `gh issue`, `gh api`, `gh repo` (it may read CI logs with `gh run view`); MCP servers |

Every call runs with `--strict-mcp-config` and no MCP config, so no MCP servers load, and with `--tools` / `--disallowedTools` limiting the tools as above. All three return JSON validated against a schema (`--json-schema`), so the driver never routes on free-form prose.

## The OS sandbox (coder and reviewer)

Each call gets Claude Code `sandbox` settings through `--settings`:

- **Writes.** Bash, and everything it spawns, may write only to the task's worktree, its git admin directory, temp directories and package caches.
- **Network.** It may reach only `network.allowedDomains` (the npm registry by default) and localhost.
- **Reads.** It may not read home credentials (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.kube`, `~/.azure`, `~/.config/gcloud`) or the project's `secretFiles`.
- **Fails closed.** `failIfUnavailable` and `allowUnsandboxedCommands: false` mean there's no unsandboxed fallback. If the sandbox is unavailable on the machine, the call doesn't run at all.

Read/Edit/Write aren't OS-sandboxed, so permission deny rules cover them:
- no reading credentials or secret files;
- no editing any top-level entry of the main checkout except the worktree folder, which covers the crew's own files, its state and the issue files;
- no editing home dotfiles.

## What the scripts enforce

- **Scope.** The driver diffs the whole branch against its base, untracked files included. Any path outside `allowed_files` is a finding and is never committed. `crew validate` refuses contracts that would let a task edit the issue files or the crew itself.
- **Git and the remote.** Only the driver, `crew merge` and `crew wrapup` commit, and in github mode push, open PRs and update issues. Nothing is ever force-pushed or rebased.
- **Merges.** `crew merge` refuses unless:
  - the task is `ready_to_merge` and its dependencies are merged;
  - **local mode:** the branch tip is the approved commit and already contains the current base;
  - **github mode:** the PR head is the approved commit, every check is green, and GitHub reports it mergeable.
- **Nothing leaves the machine in local mode.** The driver never pushes, and the boss's authorization for a run covers local merges only.

## What you still own

- **Contracts.** The crew does exactly what the contracts allow. Read the plan before a run starts (`/crew plan-only`), especially `allowed_files`, `setup` and the check commands: the driver runs them outside the sandbox, as you.
- **The adapter.** A project's issue adapter is code that the crew imports and runs. Review it like any other code before committing it.
- **Triage runs outside the sandbox.** It may run Docker and stop processes. Its git writes and remote `gh` actions are denied, but it's a capable shell on your machine.
- **Secrets in the repo.** The deny rules cover `secretFiles` and common credential directories, not secrets committed to source files or kept elsewhere.
- **CI, in github mode.** The crew trusts your CI's verdict. Weak CI checks give weak protection.

## Known limits

- On macOS the sandbox blocks git over SSH, Docker and Apple Events inside coder/reviewer Bash. The driver runs every check outside the sandbox, so this only limits the coder's own self-checks.
- Heavy native toolchains (simulators, IDE build systems) are untested inside the sandbox. Leave them to the contract's checks and gates.
- `--permission-mode auto` applies to every call. A denied action fails that call, the driver asks for help, and triage or the boss decides. A denial is never retried through another session.

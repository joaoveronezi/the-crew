# Security

The crew runs code-writing agents unattended, so their limits are enforced by Claude Code's CLI and the operating system, not by instructions in a prompt.

## What each agent can do

| agent | tools | sandbox | can't |
| --- | --- | --- | --- |
| coder | Read, Edit, Write, Bash, Grep, Glob | OS sandbox | commit, push, merge, reset, branch or stash (`git restore` is allowed); use `gh`; load MCP servers |
| reviewer | Read, Bash, Grep, Glob | OS sandbox | any git write; use `gh`; load MCP servers. Anything it leaves in the worktree is reset |
| triage | Read, Bash, Grep, Glob | none, because it may need to start a database or stop a stray process | git writes; `gh pr`, `gh issue`, `gh api`, `gh repo` (it may read CI logs); load MCP servers |

Every agent answers in JSON checked against a schema, so the scripts never act on free-form text.

## The sandbox (coder and reviewer)

- **Writes:** only the task's worktree, temp directories and package caches.
- **Network:** only `network.allowedDomains` (the npm registry by default) and localhost.
- **Reads:** never home credentials (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`, `~/.docker`, `~/.kube`, …) or the project's `secretFiles`.
- **Fails closed:** if the sandbox isn't available on the machine, the call doesn't run at all. There's no unsandboxed fallback.

File tools aren't covered by the OS sandbox, so permission rules cover them: no reading credentials or secret files, and no editing anything in your main checkout outside the task's worktree.

## What the scripts guarantee

- **Scope.** A changed file outside the contract's `allowed_files` is never committed. `crew validate` refuses contracts that would let a task edit the issue files or the crew itself.
- **Git.** Only the scripts commit, push, open PRs and update issues. Nothing is ever force-pushed or rebased.
- **Merges.** `crew merge` refuses unless the task is approved, its dependencies are merged, and the commit being merged is exactly the one that was checked. In github mode, CI must also be green and GitHub must report the PR mergeable.
- **Local mode sends nothing anywhere.** No pushes and no PRs.

## What stays your responsibility

- **The contracts.** Check commands and `setup` run outside the sandbox, as you. Read the plan before the first run (`/crew plan-only`).
- **The issue adapter.** If `/crew adapt` writes one, it's code the crew runs. Review it before committing it.
- **Triage.** It's an unsandboxed shell on your machine: it can't write to git or GitHub, but it can run Docker and stop processes.
- **Secrets in the repo.** The rules cover `secretFiles` and common credential directories, not secrets committed to source files.
- **Your CI, in github mode.** The crew trusts its verdict. Weak checks give weak protection.

## Known limits

- On macOS, the sandbox blocks git over SSH, Docker and Apple Events inside coder and reviewer commands. The driver runs every check outside the sandbox, so this only limits the coder's own self-checks.
- Heavy native toolchains (simulators, IDE builds) are untested inside the sandbox. Leave them to the contract's checks.
- A permission denial fails that call. The driver asks for help, and triage or the boss decides. A denial is never retried another way.

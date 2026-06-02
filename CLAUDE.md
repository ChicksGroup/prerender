# Working agreement for Claude Code

## Git workflow — standing authorization

Claude Code is authorized to **commit, push, open pull requests, merge, and delete merged
branches** in this repository **without asking for confirmation each time**. Proceed by default.

Conventions:
- Default branch: `master`. Always work on a feature branch (never commit directly to `master`),
  branched from `master`.
- Open a PR to `master`, wait for CI to pass, **squash-merge**, then delete the branch
  (remote + local) and fast-forward local `master`.
- Commit subjects follow the repo's `area: summary` style (e.g. `cache:`, `render:`).
- Include the Claude Code co-author trailer on commits.
- Still verify before merging and report outcomes honestly.

## Project notes

- Self-hosted **prerender** fork (Node.js) — the crawler-facing render + cache service.
- Tests: `npm test` (mocha). Tests must pass before merging; CI runs a `build` matrix on PRs.
- Deployed on **DigitalOcean App Platform** (Docker); Redis/Valkey for the cache; the PHP
  ops dashboard pushes cache policy here via the token-protected `/cache/*` endpoints.
- For substantial changes, run an adversarial review and apply confirmed findings before merging.

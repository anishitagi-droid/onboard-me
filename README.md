# onboard-me

Auto-generated onboarding path for new contributors. Replaces a static,
rotting `CONTRIBUTING.md` with an `ONBOARDING.md` regenerated from your
actual git history, code ownership, and open issues.

See [`onboard-me-spec.md`](./onboard-me-spec.md) for the full architecture
and prompt design this implements.

## Install

```bash
npm install
npm link   # optional, to get the `onboard-me` command globally
```

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=ghp_...        # optional — enables "first issue" candidates
```

## Usage

```bash
# from inside the repo you want an onboarding path for
npx onboard-me

# custom options
npx onboard-me --window-days 90 --model claude-sonnet-5 --out ./docs

# skip the LLM call and just inspect what would be sent to it
npx onboard-me --dry-run

# skip GitHub issue lookups (e.g. private repo without a token)
npx onboard-me --no-issues
```

## Output

- `onboarding.json` — structured source of truth, versioned in your repo
- `ONBOARDING.md` — rendered, human-readable version

Re-run anytime (e.g. in CI on merge to main, or on a schedule) to keep it
fresh. The tool feeds the previous `onboarding.json` back in as context so
the plan stays stable rather than reshuffling on every run.

## What it does NOT do

- Does not run `git blame` per-file (expensive on large repos) — ownership
  is approximated from commit-count-per-author-per-directory. See
  `src/gather-git.js` for where to swap in true blame-based ownership.
- Does not hit any tracker besides GitHub Issues out of the box. Jira/Linear
  support would be a new `gather-issues-*.js` module feeding the same
  `candidate_issues` shape into `aggregate.js`.

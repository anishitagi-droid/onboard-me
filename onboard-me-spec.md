# `onboard-me` — Auto-Generated Onboarding Path

**Spec: architecture, data pipeline, and the LLM prompt**

---

## 1. Why this shape

A single LLM call cannot reliably read an entire git history + issue tracker + docs tree and reason well *and* return clean structured output — context gets huge and hallucination risk climbs. So the tool splits work into two layers:

```
┌─────────────────────────────┐      ┌──────────────────────────┐      ┌─────────────────────┐
│  1. DETERMINISTIC GATHER    │ ---> │  2. ONE LLM CALL          │ ---> │  3. RENDER           │
│  (plain code, no LLM)       │      │  (structured JSON out)    │      │  (template, no LLM)  │
│  git log/blame, issue API,  │      │  reasons over pre-        │      │  JSON -> ONBOARDING  │
│  docs excerpts -> compact   │      │  aggregated context,      │      │  .md via template     │
│  JSON context payload       │      │  returns onboarding.json  │      │                       │
└─────────────────────────────┘      └──────────────────────────┘      └─────────────────────┘
```

Rule of thumb: **anything countable or greppable happens in code before the prompt.** The LLM's job is judgment (what's a good first issue, how to sequence a tour, what an area of the codebase is "about"), not arithmetic (churn counts, blame percentages, issue filtering).

---

## 2. Layer 1 — Data collection (runs locally, no LLM)

CLI command: `npx onboard-me` (reads current repo + optional flags for issue tracker auth/repo slug).

### 2a. Git signals
- `git log --since=<window> --numstat --format=...` → commits per file, per author, per directory
- Churn score per top-level directory/module (commit frequency × recency-weighted)
- `git blame`-derived ownership: primary owner (>50% of lines) and top 3 contributors per file/directory
- **Bus factor** flag: directories where one person owns >80% of recent commits
- Commit message topic clustering (lightweight — group by conventional-commit prefix `feat:`, `fix:`, `docs:`, etc., not LLM-based)

### 2b. Issue tracker signals (GitHub Issues / Jira via API)
- Open issues labeled `good first issue`, `help wanted`, or low-complexity heuristics (short title, few comments, no linked PR)
- Issue age, comment count, whether previously assigned/abandoned
- Map each candidate issue to the file paths/directories it likely touches (via linked PRs on similar past issues, or label-to-path heuristics if configured)

### 2c. Docs signals
- `README.md`, `/docs/**`, `CONTRIBUTING.md` (if it exists, mined for anything still-valid, not discarded), ADRs
- Extract only headings + first paragraph per section (not full text) to keep payload small

### 2d. Aggregation output
All of the above gets compacted into one JSON object — this is the **only** thing that goes into the prompt. Target: a few KB, not the raw log.

```json
{
  "repo": { "name": "acme/widget-api", "primary_languages": ["TypeScript", "Go"], "analyzed_commits": 1240, "window_days": 180 },
  "directories": [
    {
      "path": "src/billing",
      "commit_count_90d": 84,
      "primary_owner": "jsmith",
      "contributors": ["jsmith", "arao", "kchen"],
      "bus_factor_risk": false,
      "recent_commit_topics": ["fix", "feat"]
    }
  ],
  "candidate_issues": [
    { "id": "GH-482", "title": "Add currency validation to invoice form", "labels": ["good first issue"], "age_days": 12, "comment_count": 1, "likely_paths": ["src/billing/invoice.ts"] }
  ],
  "docs_excerpts": [
    { "source": "README.md", "heading": "Architecture Overview", "summary": "..." }
  ]
}
```

---

## 3. Layer 2 — The prompt

One call, temperature low (~0.2–0.3), forced structured JSON output (use tool-use/function-calling or `response_format: json` if the API supports it — do not rely on prose-parsing).

### System prompt

```
You are the onboarding-path architect for a software repository. You will be given
a compact JSON summary of the repo's git history, code ownership, candidate first
issues, and documentation excerpts. Your job is to produce a structured onboarding
plan for a brand-new contributor who has never seen this codebase.

Hard constraints:
1. Only reference files, directories, owners, and issue IDs that appear in the
   input data. Never invent a file path, person, or issue number.
2. If the input data is insufficient to confidently fill a field, output an
   explicit "insufficient_data" note for that field instead of guessing.
3. Order the first-issue path from lowest to highest complexity, using commit
   churn, bus-factor risk, and issue comment/age signals as proxies for difficulty
   — not your own assumptions about what "sounds hard."
4. Prefer directories with more than one contributor for early recommendations
   (avoids dropping a newcomer into a single-owner silo on day one).
5. Write descriptions for a contributor with general software experience but zero
   context on this specific repo. Avoid restating the obvious (e.g. do not say
   "this is a folder that contains files").
6. Output must be valid JSON matching the schema below. No prose, no markdown
   fences, no commentary outside the JSON object.

Output schema:
{
  "generated_at": "<ISO 8601 timestamp>",
  "architecture_tour": [
    { "area": string, "description": string, "key_paths": [string],
      "owners": [string], "suggested_read_order": number }
  ],
  "ownership_map": [
    { "path": string, "primary_owner": string, "contributors": [string],
      "bus_factor_risk": boolean }
  ],
  "first_issue_path": [
    { "step": number, "issue_id": string | null,
      "task_description": string, "area": string,
      "rationale": string, "estimated_complexity": "low" | "medium" | "high" }
  ],
  "notes": [ { "field": string, "issue": "insufficient_data" | "low_confidence",
    "detail": string } ]
}
```

### User prompt (templated)

```
Repo context (JSON):
{{AGGREGATED_CONTEXT_JSON}}

Generate the onboarding plan now, following the schema and constraints in the
system prompt exactly.
```

That's it — deliberately thin. All the "intelligence" is in the pre-aggregated data quality, not prompt cleverness. This is the biggest lever for output quality: garbage aggregation in Layer 1 → garbage plan out, no matter how well-worded the prompt is.

### Why these specific constraints exist
- **"Never invent a file path/issue ID"** — the single biggest failure mode for this kind of tool is a confidently-wrong architecture tour pointing a newcomer at a file that doesn't exist or was deleted. Grounding to the input list is non-negotiable.
- **"insufficient_data instead of guessing"** — repos with short history or no issue tracker access will legitimately have gaps; surfacing that beats silently hallucinating a full tour.
- **Ordering by churn/bus-factor, not vibes** — keeps the "difficulty" ranking auditable and re-derivable, not a black-box LLM opinion.

---

## 4. Layer 3 — Render

`onboarding.json` (source of truth, versioned, diffable) → template engine → `ONBOARDING.md`.

Suggested `ONBOARDING.md` layout:

```markdown
# Onboarding Path
_Generated {{generated_at}} · Regenerate anytime with `npx onboard-me`_

## Architecture Tour
{{#each architecture_tour sorted by suggested_read_order}}
### {{area}}
{{description}}
**Key files:** {{key_paths}} · **Owners:** {{owners}}
{{/each}}

## Suggested First Issues
{{#each first_issue_path sorted by step}}
1. **{{task_description}}** ({{estimated_complexity}})
   {{#if issue_id}}Issue: {{issue_id}}{{/if}}
   Why this one: {{rationale}}
{{/each}}

## Code Ownership Map
| Path | Primary Owner | Bus Factor Risk |
|---|---|---|
{{#each ownership_map}}| {{path}} | {{primary_owner}} | {{bus_factor_risk}} |
{{/each}}

{{#if notes}}
## Known Gaps
_Areas where we didn't have enough data to be confident — contributions to fill
these in are welcome._
{{#each notes}}- {{field}}: {{detail}}{{/each}}
{{/if}}
```

Keep `ONBOARDING.md` explicitly marked as generated (with the regen command) so no one hand-edits it and creates drift — same rot problem you're trying to solve, just one level down.

---

## 5. Regeneration / staleness handling

- Diff new `onboarding.json` against the previous committed version; if the `first_issue_path` is >X% unchanged, skip the commit (avoid noisy PRs every run).
- Store `analyzed_commits` / `window_days` in the output so contributors can see how fresh the analysis is.
- On re-run, feed the previous `onboarding.json` back in as optional context (`{{PREVIOUS_PLAN_JSON}}`) with an instruction: *"Prefer stability — only change a recommendation if the underlying data materially changed."* This prevents the plan from reshuffling every single run for cosmetic reasons.

---

## 6. Edge cases to design for

| Case | Handling |
|---|---|
| No issue tracker auth provided | `candidate_issues` empty → prompt still runs, `first_issue_path` entries have `issue_id: null` with a generic task description instead |
| Very young repo (<50 commits) | Flag in `notes`; architecture tour still generated from file structure + docs alone |
| Monorepo with many packages | Run Layer 1 aggregation per-package, either one prompt per package or one prompt with a `packages` array — decide based on typical repo size in your target audience |
| Single-owner repo (whole thing is one person) | `bus_factor_risk: true` everywhere is expected and fine — don't treat it as a data problem |

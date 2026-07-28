import { Octokit } from "@octokit/rest";

const CANDIDATE_LABELS = ["good first issue", "help wanted", "good-first-issue", "beginner-friendly"];

/**
 * Pulls low-friction "first issue" candidates from GitHub Issues.
 * Returns [] on any auth/network failure rather than throwing — issue data
 * is optional context, not a hard dependency for the rest of the pipeline.
 *
 * `octokitClient` is accepted for testability (inject a fake with a
 * `.issues.listForRepo` method); real callers can omit it and a real
 * Octokit instance is constructed from `token`.
 */
export async function gatherIssues({ repoSlug, token, octokitClient }) {
  if (!repoSlug) return { candidate_issues: [], skipped_reason: "no repo slug detected" };

  // Unauthenticated requests work fine against public repos (just a lower
  // rate limit — 60/hr vs 5000/hr), so only skip entirely if there's no slug.
  const [owner, repo] = repoSlug.split("/");
  const octokit = octokitClient || new Octokit(token ? { auth: token } : {});

  try {
    // GitHub's `labels` query param is AND semantics (issue must have every listed
    // label), not OR -- so these genuinely can't be combined into one request; we
    // want "has ANY of these labels". But the 4 requests are otherwise fully
    // independent of each other and were being awaited one at a time, paying 4x
    // the round-trip latency for no reason. Run them concurrently instead.
    const responses = await Promise.all(
      CANDIDATE_LABELS.map((label) =>
        octokit.issues.listForRepo({ owner, repo, state: "open", labels: label, per_page: 15 })
      )
    );
    const results = responses.flatMap((r) => r.data);

    // de-dupe by issue number, drop anything that's actually a PR
    const seen = new Map();
    for (const issue of results) {
      if (issue.pull_request) continue;
      seen.set(issue.number, issue);
    }

    const candidate_issues = [...seen.values()].map((issue) => ({
      id: `GH-${issue.number}`,
      title: issue.title,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
      age_days: Math.floor((Date.now() - new Date(issue.created_at)) / 86_400_000),
      comment_count: issue.comments,
      // Path inference from issue body/title is a heuristic best-effort;
      // real implementations could cross-reference merged PRs that closed similar issues.
      likely_paths: inferLikelyPaths(issue),
    }));

    return { candidate_issues };
  } catch (err) {
    return { candidate_issues: [], skipped_reason: `GitHub API error: ${err.message}` };
  }
}

function inferLikelyPaths(issue) {
  const text = `${issue.title} ${issue.body || ""}`;
  // crude but cheap: pull anything that looks like a file path or dir mention.
  // Extension list kept in sync with detectPrimaryLanguages' extToLang in
  // gather-git.js -- it used to only cover a subset (ts/tsx/js/jsx/py/go/rb/
  // java/md), so an issue mentioning e.g. a .rs or .swift file in a Rust or
  // Swift repo silently got likely_paths: [] even when the text plainly named
  // a real file, purely because this regex hadn't heard of that extension.
  const matches = text.match(/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|c|cpp|cs|md)\b/g) || [];
  return [...new Set(matches)].slice(0, 3);
}

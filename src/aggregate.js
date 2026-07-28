export function aggregateContext({ repoSlug, gitData, issuesData, docsData, languages }) {
  return {
    repo: {
      name: repoSlug || "(unknown — no git remote detected)",
      primary_languages: languages,
      analyzed_commits: gitData.analyzed_commits,
      window_days: gitData.window_days,
    },
    directories: gitData.directories,
    candidate_issues: issuesData.candidate_issues,
    issues_skipped_reason: issuesData.skipped_reason || null,
    docs_excerpts: docsData.docs_excerpts,
  };
}

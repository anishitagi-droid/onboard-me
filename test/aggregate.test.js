import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { aggregateContext } from "../src/aggregate.js";

describe("aggregateContext", () => {
  test("combines all four inputs into the documented shape", () => {
    const ctx = aggregateContext({
      repoSlug: "acme/widget",
      gitData: { analyzed_commits: 10, window_days: 90, directories: [{ path: "src" }] },
      issuesData: { candidate_issues: [{ id: "GH-1" }] },
      docsData: { docs_excerpts: [{ source: "README.md" }] },
      languages: ["TypeScript"],
    });
    assert.equal(ctx.repo.name, "acme/widget");
    assert.equal(ctx.repo.analyzed_commits, 10);
    assert.equal(ctx.repo.window_days, 90);
    assert.deepEqual(ctx.repo.primary_languages, ["TypeScript"]);
    assert.deepEqual(ctx.directories, [{ path: "src" }]);
    assert.deepEqual(ctx.candidate_issues, [{ id: "GH-1" }]);
    assert.deepEqual(ctx.docs_excerpts, [{ source: "README.md" }]);
    assert.equal(ctx.issues_skipped_reason, null);
  });

  test("falls back to a clear placeholder name when no repo slug was detected", () => {
    const ctx = aggregateContext({
      repoSlug: null,
      gitData: { analyzed_commits: 0, window_days: 180, directories: [] },
      issuesData: { candidate_issues: [] },
      docsData: { docs_excerpts: [] },
      languages: [],
    });
    assert.equal(ctx.repo.name, "(unknown — no git remote detected)");
  });

  test("surfaces issues_skipped_reason when issues were skipped", () => {
    const ctx = aggregateContext({
      repoSlug: "acme/widget",
      gitData: { analyzed_commits: 0, window_days: 180, directories: [] },
      issuesData: { candidate_issues: [], skipped_reason: "--no-issues passed" },
      docsData: { docs_excerpts: [] },
      languages: [],
    });
    assert.equal(ctx.issues_skipped_reason, "--no-issues passed");
  });
});

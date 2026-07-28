import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gatherIssues } from "../src/gather-issues.js";

function fakeOctokit(issuesByLabel) {
  const calls = [];
  return {
    calls,
    issues: {
      listForRepo: async ({ labels }) => {
        calls.push(labels);
        return { data: issuesByLabel[labels] || [] };
      },
    },
  };
}

describe("gatherIssues", () => {
  test("returns empty with a clear reason when no repo slug is available", async () => {
    const result = await gatherIssues({ repoSlug: null, token: null });
    assert.deepEqual(result.candidate_issues, []);
    assert.equal(result.skipped_reason, "no repo slug detected");
  });

  test("queries all 4 candidate labels concurrently, not sequentially", async () => {
    // Regression test for a real inefficiency: the 4 label queries were awaited
    // one at a time despite being fully independent, paying 4x round-trip
    // latency for nothing. Verify all 4 requests are in flight before any
    // resolves, proving they're issued concurrently via Promise.all rather than
    // a sequential for-loop.
    let concurrentInFlight = 0;
    let maxConcurrentSeen = 0;
    const octokit = {
      issues: {
        listForRepo: async () => {
          concurrentInFlight++;
          maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentInFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrentInFlight--;
          return { data: [] };
        },
      },
    };
    await gatherIssues({ repoSlug: "acme/widget", octokitClient: octokit });
    assert.equal(maxConcurrentSeen, 4, "expected all 4 label queries to be in flight at once");
  });

  test("de-duplicates an issue that matches multiple candidate labels", async () => {
    const issue = { number: 5, title: "Fix thing", labels: [{ name: "bug" }], comments: 0, created_at: new Date().toISOString() };
    const octokit = fakeOctokit({
      "good first issue": [issue],
      "help wanted": [issue], // same issue, matched by a second label too
    });
    const result = await gatherIssues({ repoSlug: "acme/widget", octokitClient: octokit });
    assert.equal(result.candidate_issues.length, 1);
  });

  test("drops pull requests (issues API returns PRs too)", async () => {
    const pr = { number: 9, title: "A PR", pull_request: {}, labels: [], comments: 0, created_at: new Date().toISOString() };
    const octokit = fakeOctokit({ "good first issue": [pr] });
    const result = await gatherIssues({ repoSlug: "acme/widget", octokitClient: octokit });
    assert.deepEqual(result.candidate_issues, []);
  });

  test("infers likely_paths for every language detectPrimaryLanguages supports, not just a subset (regression test)", () => {
    // Regression test for a real inconsistency: inferLikelyPaths' extension list
    // used to be a strict subset of detectPrimaryLanguages' language list in
    // gather-git.js, so an issue mentioning e.g. a .rs or .swift file in a repo
    // whose primary language IS Rust/Swift silently got likely_paths: [].
    const extensions = ["ts", "tsx", "js", "jsx", "py", "go", "rs", "rb", "java", "kt", "swift", "c", "cpp", "cs"];
    return (async () => {
      for (const ext of extensions) {
        const issue = {
          number: 1,
          title: `Fix bug in src/main.${ext}`,
          labels: [],
          comments: 0,
          created_at: new Date().toISOString(),
        };
        const octokit = fakeOctokit({ "good first issue": [issue] });
        const result = await gatherIssues({ repoSlug: "acme/widget", octokitClient: octokit });
        assert.deepEqual(
          result.candidate_issues[0].likely_paths,
          [`src/main.${ext}`],
          `expected .${ext} to be detected`
        );
      }
    })();
  });

  test("returns empty with the error message when the GitHub API fails", async () => {
    const octokit = {
      issues: {
        listForRepo: async () => {
          throw new Error("API rate limit exceeded");
        },
      },
    };
    const result = await gatherIssues({ repoSlug: "acme/widget", octokitClient: octokit });
    assert.deepEqual(result.candidate_issues, []);
    assert.match(result.skipped_reason, /rate limit exceeded/);
  });
});

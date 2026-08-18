import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, readPreviousPlan } from "../src/index.js";

function git(repoPath, args) {
  execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" });
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "onboard-me-index-test-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "t"]);
  return repo;
}

async function runWithCapturedLogs(opts) {
  // Both scenarios below need to intercept the shared global console.log, and
  // Node's test runner runs sibling test() functions within a describe block
  // concurrently by default (verified independently) -- two separate tests
  // each swapping console.log in and out raced against each other and
  // corrupted each other's captured output. Consolidating into one test
  // function (this helper, called twice sequentially within it) sidesteps
  // that entirely rather than fighting the test runner's concurrency options.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await run(opts);
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

describe("run (dry-run integration)", () => {
  const repos = [];
  after(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  test("real Layer 1 pipeline (git + docs + aggregation) runs end to end against a real repo without ever needing an API key, and repoSlug override takes priority over the detected git remote", async () => {
    const repo = makeRepo();
    repos.push(repo);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/widget-api.git"]);
    mkdirSync(join(repo, "src", "billing"), { recursive: true });
    writeFileSync(join(repo, "src", "billing", "invoice.ts"), "export const x = 1;\n");
    writeFileSync(join(repo, "README.md"), "# Widget API\nA billing service.\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "initial commit"]);

    // Deliberately never sets ANTHROPIC_API_KEY and never reaches the LLM call --
    // --dry-run exits right after Layer 1 (gather + aggregate), which is exactly
    // the part of the pipeline most prone to real bugs (path handling, git
    // parsing, docs extraction) and the part this test suite can exercise for
    // real without an API key, unlike llm.js/prompt.js which are unit-tested
    // separately with a fake Anthropic client instead.
    const output = await runWithCapturedLogs({
      path: repo,
      out: repo,
      windowDays: 180,
      model: "claude-sonnet-5",
      issues: false,
      dryRun: true,
    });

    assert.match(output, /analyzing/);
    // 2, not 1: README.md (at the repo root) legitimately gets its own "(root)"
    // directory grouping alongside src/billing -- it's a committed file too.
    assert.match(output, /2 directories, 0 candidate issues, 1 doc excerpts/);
    assert.match(output, /"name": "acme\/widget-api"/);
    assert.match(output, /"path": "src\/billing"/);
    assert.match(output, /"source": "README\.md"/);
    // dry-run must never write output files
    assert.ok(!output.includes("Wrote "));

    const overrideOutput = await runWithCapturedLogs({
      path: repo,
      out: repo,
      windowDays: 180,
      model: "claude-sonnet-5",
      issues: false,
      dryRun: true,
      repoSlug: "explicit/override",
    });
    assert.match(overrideOutput, /"name": "explicit\/override"/);
  });
});

describe("readPreviousPlan", () => {
  test("returns null when the file doesn't exist", () => {
    assert.equal(readPreviousPlan("/tmp/definitely-does-not-exist-onboard-me.json"), null);
  });

  test("returns the parsed plan when the file is valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "onboard-me-prevplan-test-"));
    const path = join(dir, "onboarding.json");
    writeFileSync(path, JSON.stringify({ architecture_tour: [] }));
    assert.deepEqual(readPreviousPlan(path), { architecture_tour: [] });
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null instead of throwing when the file is corrupted (regression test)", () => {
    // Regression test for a real inconsistency with this codebase's own
    // resilience philosophy: every other input source (docs, issues, git's
    // no-commits-yet case) treats a failure as best-effort and keeps going.
    // A previous run killed mid-write, a full disk, or a hand-edit gone
    // wrong all leave invalid JSON in onboarding.json -- which this tool
    // itself only ever uses as a "prefer stability" hint, not a required
    // input -- and JSON.parse used to throw straight out of run(), taking
    // the entire tool down over a file whose only job is a soft hint.
    const dir = mkdtempSync(join(tmpdir(), "onboard-me-prevplan-test-"));
    const path = join(dir, "onboarding.json");
    writeFileSync(path, "{ this is not valid json");
    assert.doesNotThrow(() => readPreviousPlan(path));
    assert.equal(readPreviousPlan(path), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

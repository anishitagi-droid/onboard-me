import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherGit, detectRepoSlug, detectPrimaryLanguages } from "../src/gather-git.js";

function git(repoPath, args) {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" });
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "onboard-me-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);
  return dir;
}

describe("gatherGit", () => {
  let repo;

  before(() => {
    repo = initRepo();
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("empty repo with no commits returns zero history, not a crash", () => {
    const result = gatherGit({ repoPath: repo, windowDays: 180 });
    assert.equal(result.analyzed_commits, 0);
    assert.deepEqual(result.directories, []);
  });

  test("groups files under a generic container dir one level deeper", () => {
    execFileSync("mkdir", ["-p", join(repo, "src", "billing")]);
    execFileSync("bash", ["-c", `echo "x" > "${join(repo, "src", "billing", "invoice.ts")}"`]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "add billing"]);

    const result = gatherGit({ repoPath: repo, windowDays: 180 });
    const billing = result.directories.find((d) => d.path === "src/billing");
    assert.ok(billing, "expected src/billing to be its own grouping, not just src");
    assert.equal(billing.commit_count_window, 1);
    assert.equal(billing.primary_owner, "t");
    assert.equal(billing.bus_factor_risk, true); // single contributor
  });

  test("a cross-directory rename is attributed to the NEW directory, not the old one (regression test)", () => {
    // Regression test for a real, verified bug: git's --numstat rename notation
    // ("old/path => new/path" with no shared prefix, or "prefix/{old => new}/suffix"
    // when there is one) was being treated as a single literal path. A cross-
    // directory rename with nothing shared between old and new paths was silently
    // misattributed entirely to the OLD directory, and the new directory got zero
    // credit for a file that now lives there.
    execFileSync("mkdir", ["-p", join(repo, "docs")]);
    git(repo, ["mv", "src/billing/invoice.ts", "docs/invoice-moved.ts"]);
    git(repo, ["commit", "-q", "-m", "move billing file into docs"]);

    const result = gatherGit({ repoPath: repo, windowDays: 180 });
    const docs = result.directories.find((d) => d.path === "docs");
    assert.ok(docs, "expected the move commit to credit the NEW directory (docs)");
    assert.equal(docs.commit_count_window, 1);
  });

  test("a same-directory (partial) rename still groups correctly", () => {
    const partialRepo = initRepo();
    execFileSync("mkdir", ["-p", join(partialRepo, "src", "widgets")]);
    execFileSync("bash", ["-c", `echo "x" > "${join(partialRepo, "src", "widgets", "old.js")}"`]);
    git(partialRepo, ["add", "-A"]);
    git(partialRepo, ["commit", "-q", "-m", "add widget"]);
    git(partialRepo, ["mv", "src/widgets/old.js", "src/widgets/new.js"]);
    git(partialRepo, ["commit", "-q", "-m", "rename within same dir"]);

    const result = gatherGit({ repoPath: partialRepo, windowDays: 180 });
    const widgets = result.directories.find((d) => d.path === "src/widgets");
    assert.ok(widgets);
    assert.equal(widgets.commit_count_window, 2);
    rmSync(partialRepo, { recursive: true, force: true });
  });

  test("bus_factor_risk is true when one contributor has more than 80% of commits", () => {
    const busRepo = initRepo();
    execFileSync("mkdir", ["-p", join(busRepo, "core")]);
    for (let i = 0; i < 9; i++) {
      execFileSync("bash", ["-c", `echo "${i}" >> "${join(busRepo, "core", "a.js")}"`]);
      git(busRepo, ["add", "-A"]);
      git(busRepo, ["commit", "-q", "-m", `commit ${i}`, "--author", "Alice <alice@example.com>"]);
    }
    execFileSync("bash", ["-c", `echo "last" >> "${join(busRepo, "core", "a.js")}"`]);
    git(busRepo, ["add", "-A"]);
    git(busRepo, ["commit", "-q", "-m", "commit 10", "--author", "Bob <bob@example.com>"]);

    const result = gatherGit({ repoPath: busRepo, windowDays: 180 });
    const core = result.directories.find((d) => d.path === "core");
    assert.equal(core.primary_owner, "Alice");
    assert.equal(core.bus_factor_risk, true); // 9/10 = 90% > 80%
    rmSync(busRepo, { recursive: true, force: true });
  });

  test("directories are sorted by commit count descending", () => {
    const result = gatherGit({ repoPath: repo, windowDays: 180 });
    for (let i = 1; i < result.directories.length; i++) {
      assert.ok(result.directories[i - 1].commit_count_window >= result.directories[i].commit_count_window);
    }
  });
});

describe("detectRepoSlug", () => {
  test("extracts owner/repo from an https github remote", () => {
    const repo = initRepo();
    git(repo, ["remote", "add", "origin", "https://github.com/acme/widget-api.git"]);
    assert.equal(detectRepoSlug(repo), "acme/widget-api");
    rmSync(repo, { recursive: true, force: true });
  });

  test("extracts owner/repo from an ssh github remote", () => {
    const repo = initRepo();
    git(repo, ["remote", "add", "origin", "git@github.com:acme/widget-api.git"]);
    assert.equal(detectRepoSlug(repo), "acme/widget-api");
    rmSync(repo, { recursive: true, force: true });
  });

  test("returns null when there is no remote", () => {
    const repo = initRepo();
    assert.equal(detectRepoSlug(repo), null);
    rmSync(repo, { recursive: true, force: true });
  });

  test("does not leak git's raw stderr to the terminal when there is no remote (regression test)", () => {
    // Regression test for a real UX bug: execFileSync's default stdio let git's own
    // "error: No such remote 'origin'" print straight through to the terminal even
    // though this exact scenario is caught and handled gracefully right below --
    // making a correctly-working tool look like it had just crashed. Must run in a
    // genuinely separate child process and inspect ITS stderr: the leak happens at
    // the OS file-descriptor level (an inherited grandchild `git` process writing
    // directly to fd 2), which bypasses any JS-level console/process.stderr
    // monkey-patching done from within the same process.
    const repo = initRepo();
    const gatherGitPath = JSON.stringify(join(process.cwd(), "src", "gather-git.js").replace(/\\/g, "/"));
    const script = `
      import { detectRepoSlug } from "file://${gatherGitPath.slice(1, -1)}";
      detectRepoSlug(${JSON.stringify(repo)});
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    rmSync(repo, { recursive: true, force: true });
    assert.equal(result.stderr.trim(), "", `expected no stderr output, got: ${result.stderr}`);
  });
});

describe("detectPrimaryLanguages", () => {
  test("ranks languages by file count, top 3 only", () => {
    const repo = initRepo();
    execFileSync("bash", ["-c", `
      cd "${repo}"
      for f in a.ts b.ts c.ts d.py e.py f.go; do echo x > $f; done
      git add -A && git commit -q -m init
    `]);
    const langs = detectPrimaryLanguages(repo);
    assert.deepEqual(langs, ["TypeScript", "Python", "Go"]);
    rmSync(repo, { recursive: true, force: true });
  });
});

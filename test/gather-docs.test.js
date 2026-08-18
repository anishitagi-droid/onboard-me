import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherDocs } from "../src/gather-docs.js";

function makeRepo() {
  return mkdtempSync(join(tmpdir(), "onboard-me-docs-test-"));
}

describe("gatherDocs", () => {
  test("extracts heading + first paragraph from README.md", () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "README.md"),
      "# My Project\nAn intro paragraph.\nStill part of it.\n\n## Setup\nRun npm install.\n"
    );
    const result = gatherDocs({ repoPath: repo });
    assert.equal(result.docs_excerpts.length, 2);
    assert.equal(result.docs_excerpts[0].heading, "My Project");
    assert.equal(result.docs_excerpts[0].summary, "An intro paragraph. Still part of it.");
    assert.equal(result.docs_excerpts[0].source, "README.md");
    rmSync(repo, { recursive: true, force: true });
  });

  test("walks docs/ recursively for markdown files", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "docs", "adr"), { recursive: true });
    writeFileSync(join(repo, "docs", "adr", "0001-use-postgres.md"), "# ADR 1\nWe chose postgres.\n");
    const result = gatherDocs({ repoPath: repo });
    assert.equal(result.docs_excerpts.length, 1);
    assert.equal(result.docs_excerpts[0].source, join("docs", "adr", "0001-use-postgres.md"));
    rmSync(repo, { recursive: true, force: true });
  });

  test("source path is a clean relative path even when repoPath has a trailing slash (regression test)", () => {
    // Regression test for a real bug: the source path was computed with
    // entry.replace(repoPath + "/", ""), a string .replace() that silently no-ops
    // (leaking the full absolute filesystem path) whenever repoPath already ended
    // in a slash, since the resulting search string had a double slash that never
    // matched. Fixed with path.relative, which is robust to this regardless.
    const repo = makeRepo();
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "arch.md"), "# Architecture\nOverview text.\n");

    const result = gatherDocs({ repoPath: repo + "/" });
    assert.equal(result.docs_excerpts.length, 1);
    assert.equal(result.docs_excerpts[0].source, join("docs", "arch.md"));
    assert.ok(!result.docs_excerpts[0].source.includes(repo), "must not leak the absolute path");
    rmSync(repo, { recursive: true, force: true });
  });

  test("caps total excerpts at MAX_EXCERPTS (20)", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "docs"));
    let content = "";
    for (let i = 0; i < 30; i++) content += `# Heading ${i}\nParagraph ${i}.\n`;
    writeFileSync(join(repo, "docs", "big.md"), content);
    const result = gatherDocs({ repoPath: repo });
    assert.equal(result.docs_excerpts.length, 20);
    rmSync(repo, { recursive: true, force: true });
  });

  test("a heading with no following text produces no excerpt", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "# Empty Section\n\n## Next\nSomething here.\n");
    const result = gatherDocs({ repoPath: repo });
    assert.equal(result.docs_excerpts.length, 1);
    assert.equal(result.docs_excerpts[0].heading, "Next");
    rmSync(repo, { recursive: true, force: true });
  });

  test("missing repo path returns empty excerpts rather than throwing", () => {
    const result = gatherDocs({ repoPath: "/definitely/does/not/exist/xyz" });
    assert.deepEqual(result.docs_excerpts, []);
  });

  test("a broken symlink in docs/ is skipped, not a crash (regression test)", () => {
    // Regression test for a real bug: readdirSync lists a broken symlink fine,
    // but statSync/readFileSync on it throws ENOENT (it follows the link to a
    // target that doesn't exist) -- and nothing caught that, so a single
    // dangling symlink (a real, not-uncommon scenario, e.g. one pointing at a
    // not-yet-generated build artifact) crashed gatherDocs entirely instead of
    // just being skipped like any other best-effort-context failure.
    const repo = makeRepo();
    mkdirSync(join(repo, "docs"));
    symlinkSync("/this/does/not/exist", join(repo, "docs", "broken-link.md"));
    writeFileSync(join(repo, "docs", "real.md"), "# Real doc\nSome content.\n");

    const result = gatherDocs({ repoPath: repo });
    assert.equal(result.docs_excerpts.length, 1);
    assert.equal(result.docs_excerpts[0].source, join("docs", "real.md"));
    rmSync(repo, { recursive: true, force: true });
  });

  test("a broken symlink for README.md itself at the repo root is skipped, not a crash", () => {
    const repo = makeRepo();
    symlinkSync("/this/does/not/exist", join(repo, "README.md"));
    const result = gatherDocs({ repoPath: repo });
    assert.deepEqual(result.docs_excerpts, []);
    rmSync(repo, { recursive: true, force: true });
  });

  test("docs_truncated is false when everything fits under MAX_EXCERPTS", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "# Intro\\nOne paragraph.\\n");
    const result = gatherDocs({ repoPath: repo });
    assert.equal(result.docs_truncated, false);
    rmSync(repo, { recursive: true, force: true });
  });

  test("docs_truncated is true when there are more than MAX_EXCERPTS headings (regression test)", () => {
    // Regression test for a real inconsistency with this codebase's own
    // stated philosophy: the system prompt's hard constraint #2 says never
    // silently guess or omit when data is thin, but docs past the 20-excerpt
    // cap were dropped with no signal anywhere that it happened.
    const repo = makeRepo();
    const manyHeadings = Array.from({ length: 25 }, (_, i) => `## Section ${i}\nSome text for section ${i}.\n`).join(
      "\n"
    );
    writeFileSync(join(repo, "README.md"), manyHeadings);
    const result = gatherDocs({ repoPath: repo });
    assert.equal(result.docs_excerpts.length, 20);
    assert.equal(result.docs_truncated, true);
    rmSync(repo, { recursive: true, force: true });
  });
});

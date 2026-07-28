import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
});

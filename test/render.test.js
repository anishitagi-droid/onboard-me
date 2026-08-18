import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/render.js";

function basePlan(overrides = {}) {
  return {
    generated_at: "2024-06-01T00:00:00.000Z",
    repo: { analyzed_commits: 42, window_days: 180 },
    architecture_tour: [],
    ownership_map: [],
    first_issue_path: [],
    notes: [],
    ...overrides,
  };
}

describe("renderMarkdown", () => {
  test("sorts architecture_tour by suggested_read_order regardless of input order", () => {
    const md = renderMarkdown(
      basePlan({
        architecture_tour: [
          { area: "Second", description: "d2", key_paths: [], owners: [], suggested_read_order: 2 },
          { area: "First", description: "d1", key_paths: [], owners: [], suggested_read_order: 1 },
        ],
      })
    );
    assert.ok(md.indexOf("First") < md.indexOf("Second"));
  });

  test("sorts first_issue_path by step regardless of input order", () => {
    const md = renderMarkdown(
      basePlan({
        first_issue_path: [
          { step: 2, issue_id: null, task_description: "Second task", area: "x", rationale: "r", estimated_complexity: "low" },
          { step: 1, issue_id: null, task_description: "First task", area: "x", rationale: "r", estimated_complexity: "low" },
        ],
      })
    );
    assert.ok(md.indexOf("First task") < md.indexOf("Second task"));
  });

  test("does not mutate the input plan's arrays", () => {
    const tour = [
      { area: "B", description: "d", key_paths: [], owners: [], suggested_read_order: 2 },
      { area: "A", description: "d", key_paths: [], owners: [], suggested_read_order: 1 },
    ];
    const plan = basePlan({ architecture_tour: tour });
    renderMarkdown(plan);
    assert.equal(tour[0].area, "B"); // original array order untouched
  });

  test("a pipe character in a path or owner name does not corrupt the ownership table (regression test)", () => {
    // Regression test for a real, verified bug: interpolating raw path/owner
    // values into a markdown table cell let an embedded "|" be misread as an
    // extra column separator. "Jane | Doe" turned a 3-column row into 5 columns.
    const md = renderMarkdown(
      basePlan({
        ownership_map: [
          { path: "src/weird|dir/file.js", primary_owner: "Jane | Doe", contributors: ["Bob | Carol"], bus_factor_risk: false },
        ],
      })
    );
    const row = md.split("\n").find((l) => l.includes("weird"));
    // Count unescaped pipes only -- a "\|" is an escaped literal, not a column
    // separator, so a naive split on every "|" would itself miscount (that
    // was the bug in an earlier version of this exact test). 4 columns = 5 pipes.
    const unescapedPipeCount = (row.match(/(?<!\\)\|/g) || []).length;
    assert.equal(unescapedPipeCount, 5, `expected 5 unescaped pipes (4 columns), got: ${row}`);
    assert.ok(row.includes("weird\\|dir"));
    assert.ok(row.includes("Jane \\| Doe"));
    assert.ok(row.includes("Bob \\| Carol"));
  });

  test("an embedded newline in rationale/detail/description does not break a numbered step or bullet out of its list (regression test)", () => {
    // Regression test for the same bug class as the pipe-character test above,
    // just missed in the non-table code paths when that fix was made. A
    // CommonMark list-item continuation line must be indented to stay part of
    // the item; a raw, unindented "\n" mid-string (plausible LLM output for a
    // multi-sentence rationale/detail) ends the list item instead, verified
    // concretely by rendering a plan built exactly this way and checking the
    // second half of the sentence didn't end up on its own unindented line.
    const md = renderMarkdown(
      basePlan({
        architecture_tour: [
          {
            area: "Billing",
            description: "Line one.\nLine two.",
            key_paths: [],
            owners: [],
            suggested_read_order: 1,
          },
        ],
        first_issue_path: [
          {
            step: 1,
            issue_id: "GH-1",
            task_description: "Fix it",
            area: "Billing",
            rationale: "Because\nit is broken",
            estimated_complexity: "low",
          },
        ],
        notes: [{ field: "owners", issue: "low_confidence", detail: "Only one\ncommit in window" }],
      })
    );
    const lines = md.split("\n");
    assert.ok(!lines.includes("Line two."), "description's second line leaked onto its own unindented line");
    assert.ok(lines.some((l) => l === "   Why this one: Because it is broken"));
    assert.ok(!lines.includes("it is broken"), "rationale's second line leaked onto its own unindented line");
    assert.ok(lines.some((l) => l === "- **owners** (low_confidence): Only one commit in window"));
    assert.ok(!lines.includes("commit in window"), "detail's second line leaked onto its own unindented line");
  });

  test("ownership table includes a Contributors column, not silently dropping data the LLM was given and returned", () => {
    // The contributors list is computed by gather-git.js, sent to the LLM, and
    // returned in ownership_map, but used to be dropped entirely at render time --
    // never shown to the person actually reading ONBOARDING.md. A newcomer
    // deciding who to ask about an area benefits from seeing more than just the
    // single primary owner.
    const md = renderMarkdown(
      basePlan({
        ownership_map: [
          { path: "src/billing", primary_owner: "jsmith", contributors: ["jsmith", "arao", "kchen"], bus_factor_risk: false },
        ],
      })
    );
    assert.ok(md.includes("| Path | Primary Owner | Contributors | Bus Factor Risk |"));
    assert.ok(md.includes("jsmith, arao, kchen"));
  });

  test("empty contributors list renders as an em dash", () => {
    const md = renderMarkdown(
      basePlan({
        ownership_map: [{ path: "a.js", primary_owner: "x", contributors: [], bus_factor_risk: false }],
      })
    );
    assert.ok(md.includes("| a.js | x | — | no |"));
  });

  test("missing primary_owner renders as an em dash, not 'null'", () => {
    const md = renderMarkdown(
      basePlan({
        ownership_map: [{ path: "a.js", primary_owner: null, contributors: [], bus_factor_risk: false }],
      })
    );
    assert.ok(md.includes("| a.js | — | — | no |"));
  });

  test("empty key_paths/owners render as an em dash, not an empty string", () => {
    const md = renderMarkdown(
      basePlan({
        architecture_tour: [
          { area: "Core", description: "d", key_paths: [], owners: [], suggested_read_order: 1 },
        ],
      })
    );
    assert.ok(md.includes("**Key paths:** —"));
    assert.ok(md.includes("**Owners:** —"));
  });

  test("Known Gaps section is omitted entirely when there are no notes", () => {
    const md = renderMarkdown(basePlan({ notes: [] }));
    assert.ok(!md.includes("Known Gaps"));
  });

  test("Known Gaps section lists every note when present", () => {
    const md = renderMarkdown(
      basePlan({ notes: [{ field: "ownership_map", issue: "insufficient_data", detail: "too few commits" }] })
    );
    assert.ok(md.includes("Known Gaps"));
    assert.ok(md.includes("ownership_map"));
    assert.ok(md.includes("too few commits"));
  });

  test("an issue with a null issue_id omits the Issue line but keeps Area", () => {
    const md = renderMarkdown(
      basePlan({
        first_issue_path: [
          { step: 1, issue_id: null, task_description: "Do a thing", area: "core", rationale: "r", estimated_complexity: "low" },
        ],
      })
    );
    assert.ok(!md.includes("Issue: null"));
    assert.ok(md.includes("Area: core"));
  });
});

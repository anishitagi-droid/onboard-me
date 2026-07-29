import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { SYSTEM_PROMPT, ONBOARDING_PLAN_TOOL, buildUserPrompt } from "../src/prompt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ONBOARDING_PLAN_TOOL schema", () => {
  test("matches the spec's four top-level required fields exactly", () => {
    assert.deepEqual(
      ONBOARDING_PLAN_TOOL.input_schema.required.sort(),
      ["architecture_tour", "first_issue_path", "notes", "ownership_map"].sort()
    );
  });

  test("estimated_complexity is constrained to the spec's exact 3 values", () => {
    const field = ONBOARDING_PLAN_TOOL.input_schema.properties.first_issue_path.items.properties.estimated_complexity;
    assert.deepEqual(field.enum, ["low", "medium", "high"]);
  });

  test("notes.issue is constrained to the spec's exact 2 values", () => {
    const field = ONBOARDING_PLAN_TOOL.input_schema.properties.notes.items.properties.issue;
    assert.deepEqual(field.enum, ["insufficient_data", "low_confidence"]);
  });

  test("every field render.js actually reads is declared in the schema (cross-file consistency check)", () => {
    const renderSrc = readFileSync(join(__dirname, "..", "src", "render.js"), "utf-8");
    const schema = ONBOARDING_PLAN_TOOL.input_schema.properties;

    const checks = [
      ["architecture_tour", ["area", "description", "key_paths", "owners", "suggested_read_order"]],
      ["ownership_map", ["path", "primary_owner", "contributors", "bus_factor_risk"]],
      ["first_issue_path", ["step", "issue_id", "task_description", "area", "rationale", "estimated_complexity"]],
      ["notes", ["field", "issue", "detail"]],
    ];
    for (const [group, fields] of checks) {
      const schemaFields = Object.keys(schema[group].items.properties);
      for (const field of fields) {
        assert.ok(schemaFields.includes(field), `schema for ${group} is missing '${field}', but render.js reads it`);
        assert.ok(renderSrc.includes(field), `render.js doesn't actually reference '${field}' from ${group} (test may be stale)`);
      }
    }
  });
});

describe("SYSTEM_PROMPT", () => {
  test("contains every hard constraint from the spec", () => {
    assert.match(SYSTEM_PROMPT, /[Nn]ever invent/);
    assert.match(SYSTEM_PROMPT, /insufficient_data/);
    assert.match(SYSTEM_PROMPT, /churn/i);
    assert.match(SYSTEM_PROMPT, /bus.factor/i);
    assert.match(SYSTEM_PROMPT, /more than one contributor|single.owner/i);
    assert.match(SYSTEM_PROMPT, /materially changed/);
  });

  test("addresses the single-owner-repo edge case from the spec's table (bus_factor_risk everywhere is expected, not a data problem)", () => {
    assert.match(SYSTEM_PROMPT, /genuinely has one contributor/i);
    assert.match(SYSTEM_PROMPT, /not a data problem/i);
  });

  test("distinguishes insufficient_data from low_confidence, not just naming both enum values", () => {
    // Real gap found by testing: the schema's notes.issue enum offers two distinct
    // reasons for a gap, but the prompt only ever explained one of them ("insufficient
    // to confidently fill a field") with no definition of what "low_confidence" means
    // or when to use it instead — the model had nothing to go on but the enum's name.
    assert.match(SYSTEM_PROMPT, /insufficient_data/);
    assert.match(SYSTEM_PROMPT, /low_confidence/);
    assert.match(SYSTEM_PROMPT, /thin|ambiguous|few data points/i);
  });
});

describe("buildUserPrompt", () => {
  test("embeds the context JSON", () => {
    const prompt = buildUserPrompt({ context: { repo: { name: "acme/widget" } } });
    assert.ok(prompt.includes("acme/widget"));
  });

  test("omits the previous-plan section entirely when none is given", () => {
    const prompt = buildUserPrompt({ context: {} });
    assert.ok(!prompt.includes("Previous plan"));
  });
});

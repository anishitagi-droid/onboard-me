import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generatePlan } from "../src/llm.js";

function fakeClient(toolInput) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push(request);
        return {
          content: [{ type: "tool_use", name: "emit_onboarding_plan", input: toolInput }],
        };
      },
    },
  };
}

describe("generatePlan", () => {
  test("throws a clear error when ANTHROPIC_API_KEY is missing and no client is injected", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(
        () => generatePlan({ context: {}, model: "claude-sonnet-5" }),
        /ANTHROPIC_API_KEY is not set/
      );
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test("forces tool use rather than trusting prose parsing", async () => {
    const client = fakeClient({ architecture_tour: [], ownership_map: [], first_issue_path: [], notes: [] });
    await generatePlan({ context: { repo: { name: "x" } }, model: "claude-sonnet-5", client });

    const request = client.calls[0];
    assert.equal(request.tool_choice.type, "tool");
    assert.equal(request.tool_choice.name, "emit_onboarding_plan");
    assert.equal(request.tools[0].name, "emit_onboarding_plan");
  });

  test("uses a low temperature for auditable, low-variance output", async () => {
    const client = fakeClient({ architecture_tour: [], ownership_map: [], first_issue_path: [], notes: [] });
    await generatePlan({ context: {}, model: "claude-sonnet-5", client });
    assert.equal(client.calls[0].temperature, 0.2);
  });

  test("includes the previous plan in the prompt when provided, for stability", async () => {
    const client = fakeClient({ architecture_tour: [], ownership_map: [], first_issue_path: [], notes: [] });
    const previousPlan = { architecture_tour: [{ area: "Old area" }] };
    await generatePlan({ context: {}, previousPlan, model: "claude-sonnet-5", client });

    const userMessage = client.calls[0].messages[0].content;
    assert.ok(userMessage.includes("Old area"));
  });

  test("merges the tool-use input with a fresh generated_at timestamp and the input repo context", async () => {
    const client = fakeClient({ architecture_tour: [{ area: "Core" }], ownership_map: [], first_issue_path: [], notes: [] });
    const context = { repo: { name: "acme/widget" } };
    const plan = await generatePlan({ context, model: "claude-sonnet-5", client });

    assert.equal(plan.repo.name, "acme/widget");
    assert.deepEqual(plan.architecture_tour, [{ area: "Core" }]);
    assert.ok(new Date(plan.generated_at).getTime() > 0);
  });

  test("throws a clear error when the model does not return the expected tool call", async () => {
    const client = {
      messages: { create: async () => ({ content: [{ type: "text", text: "oops, just prose" }] }) },
    };
    await assert.rejects(
      () => generatePlan({ context: {}, model: "claude-sonnet-5", client }),
      /did not return the expected emit_onboarding_plan tool call/
    );
  });
});

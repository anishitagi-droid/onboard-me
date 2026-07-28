import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, buildUserPrompt, ONBOARDING_PLAN_TOOL } from "./prompt.js";

/**
 * Runs the single LLM call and returns the parsed onboarding plan object.
 * Requires ANTHROPIC_API_KEY in the environment (never hardcode a key).
 *
 * `client` is accepted for testability (inject a fake with a
 * `.messages.create` method); real callers can omit it and a real Anthropic
 * client is constructed from ANTHROPIC_API_KEY.
 */
export async function generatePlan({ context, previousPlan, model, client }) {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set. Export it before running onboard-me.");
    }
    client = new Anthropic({ apiKey });
  }

  const userPrompt = buildUserPrompt({ context, previousPlan });

  const response = await client.messages.create({
    model, // e.g. "claude-sonnet-5" — check docs.claude.com/en/docs/about-claude/models for current IDs
    max_tokens: 4096,
    temperature: 0.2,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [ONBOARDING_PLAN_TOOL],
    tool_choice: { type: "tool", name: "emit_onboarding_plan" },
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Model did not return the expected emit_onboarding_plan tool call.");
  }

  return {
    generated_at: new Date().toISOString(),
    repo: context.repo,
    ...toolUse.input,
  };
}

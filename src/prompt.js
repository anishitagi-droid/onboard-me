export const SYSTEM_PROMPT = `You are the onboarding-path architect for a software repository. You will be given a compact JSON summary of the repo's git history, code ownership, candidate first issues, and documentation excerpts. Your job is to produce a structured onboarding plan for a brand-new contributor who has never seen this codebase.

Hard constraints:
1. Only reference directories, owners, and issue IDs that appear in the input data. Never invent a file path, person, or issue number.
2. If a field cannot be filled at all because the input data doesn't cover it, add a "notes" entry with issue: "insufficient_data" (e.g. no issue tracker data was provided, or a directory has no docs). If a field CAN be filled but the signal behind it is thin or ambiguous (e.g. only 1-2 commits in the analysis window, or an owner determined from very few data points), fill it as best you can but also add a "notes" entry with issue: "low_confidence" explaining why. Never silently guess in either case.
3. Order the first-issue path from lowest to highest complexity, using commit churn, bus-factor risk, and issue comment/age signals as proxies for difficulty — not assumptions about what "sounds hard."
4. Prefer directories with more than one contributor for early recommendations, to avoid dropping a newcomer into a single-owner silo on day one. If EVERY directory shows bus_factor_risk: true because the whole repo genuinely has one contributor, that is an accurate reflection of the codebase, not a data problem — do not add "notes" entries about it, and still produce the best onboarding path you can with what's there.
5. Write descriptions for a contributor with general software experience but zero context on this specific repo. Do not restate the obvious (e.g. do not say "this is a folder that contains files").
6. If a previous plan is provided, prefer stability: only change a recommendation if the underlying data materially changed since then.
7. Call the emit_onboarding_plan tool exactly once with the complete plan. Do not respond with prose.`;

export function buildUserPrompt({ context, previousPlan }) {
  let prompt = `Repo context (JSON):\n${JSON.stringify(context, null, 2)}\n\n`;
  if (previousPlan) {
    prompt += `Previous plan, for stability (JSON):\n${JSON.stringify(previousPlan, null, 2)}\n\n`;
  }
  prompt += `Generate the onboarding plan now, following the schema and constraints in the system prompt exactly.`;
  return prompt;
}

// JSON Schema for the forced tool-use call — this is what actually guarantees
// structured output, rather than trusting the model to format prose correctly.
export const ONBOARDING_PLAN_TOOL = {
  name: "emit_onboarding_plan",
  description: "Emit the complete structured onboarding plan for this repository.",
  input_schema: {
    type: "object",
    required: ["architecture_tour", "ownership_map", "first_issue_path", "notes"],
    properties: {
      architecture_tour: {
        type: "array",
        items: {
          type: "object",
          required: ["area", "description", "key_paths", "owners", "suggested_read_order"],
          properties: {
            area: { type: "string" },
            description: { type: "string" },
            key_paths: { type: "array", items: { type: "string" } },
            owners: { type: "array", items: { type: "string" } },
            suggested_read_order: { type: "integer" },
          },
        },
      },
      ownership_map: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "primary_owner", "contributors", "bus_factor_risk"],
          properties: {
            path: { type: "string" },
            primary_owner: { type: ["string", "null"] },
            contributors: { type: "array", items: { type: "string" } },
            bus_factor_risk: { type: "boolean" },
          },
        },
      },
      first_issue_path: {
        type: "array",
        items: {
          type: "object",
          required: ["step", "issue_id", "task_description", "area", "rationale", "estimated_complexity"],
          properties: {
            step: { type: "integer" },
            issue_id: { type: ["string", "null"] },
            task_description: { type: "string" },
            area: { type: "string" },
            rationale: { type: "string" },
            estimated_complexity: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
      },
      notes: {
        type: "array",
        items: {
          type: "object",
          required: ["field", "issue", "detail"],
          properties: {
            field: { type: "string" },
            issue: { type: "string", enum: ["insufficient_data", "low_confidence"] },
            detail: { type: "string" },
          },
        },
      },
    },
  },
};

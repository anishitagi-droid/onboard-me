import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gatherGit, detectRepoSlug, detectPrimaryLanguages } from "./gather-git.js";
import { gatherIssues } from "./gather-issues.js";
import { gatherDocs } from "./gather-docs.js";
import { aggregateContext } from "./aggregate.js";
import { generatePlan } from "./llm.js";
import { renderMarkdown } from "./render.js";

export async function run(opts) {
  const repoPath = opts.path;
  const outDir = opts.out;
  const jsonPath = join(outDir, "onboarding.json");
  const mdPath = join(outDir, "ONBOARDING.md");

  console.log(`onboard-me: analyzing ${repoPath} (last ${opts.windowDays} days)...`);

  // --- Layer 1: gather (deterministic, no LLM) ---
  const gitData = gatherGit({ repoPath, windowDays: opts.windowDays });
  const languages = detectPrimaryLanguages(repoPath);
  const repoSlug = opts.repoSlug || detectRepoSlug(repoPath);

  const issuesData = opts.issues
    ? await gatherIssues({ repoSlug, token: process.env.GITHUB_TOKEN })
    : { candidate_issues: [], skipped_reason: "--no-issues passed" };
  if (issuesData.skipped_reason) {
    console.log(`  (issues: ${issuesData.skipped_reason})`);
  }

  const docsData = gatherDocs({ repoPath });

  const context = aggregateContext({ repoSlug, gitData, issuesData, docsData, languages });
  console.log(`  gathered: ${gitData.directories.length} directories, ${issuesData.candidate_issues.length} candidate issues, ${docsData.docs_excerpts.length} doc excerpts`);

  if (opts.dryRun) {
    console.log("\n--- dry run: aggregated context ---\n");
    console.log(JSON.stringify(context, null, 2));
    return;
  }

  // --- Layer 2: one structured LLM call ---
  const previousPlan = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf-8")) : null;
  console.log(`  calling ${opts.model}...`);
  const plan = await generatePlan({ context, previousPlan, model: opts.model });

  // --- Layer 3: render ---
  writeFileSync(jsonPath, JSON.stringify(plan, null, 2));
  writeFileSync(mdPath, renderMarkdown(plan));

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  if (plan.notes?.length) {
    console.log(`\n${plan.notes.length} gap(s) flagged — see the "Known Gaps" section.`);
  }
}

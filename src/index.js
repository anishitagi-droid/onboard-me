import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gatherGit, detectRepoSlug, detectPrimaryLanguages } from "./gather-git.js";
import { gatherIssues } from "./gather-issues.js";
import { gatherDocs } from "./gather-docs.js";
import { aggregateContext } from "./aggregate.js";
import { generatePlan } from "./llm.js";
import { renderMarkdown } from "./render.js";

/**
 * Reads back a previous onboarding.json for the "prefer stability" hint
 * (system prompt constraint #6), tolerating a missing OR corrupted file.
 *
 * Every other input source in this pipeline (gatherDocs, gatherIssues,
 * gatherGit's no-commits-yet case) is treated as best-effort: a failure
 * there logs a note and the tool keeps going with less context, rather
 * than refusing to run entirely. This file, which this tool itself writes,
 * was the one exception -- a previous run killed mid-write, a full disk,
 * or a hand-edit gone wrong all leave invalid JSON on disk, and
 * JSON.parse would throw, taking the entire run down over what's only
 * ever used as a stability hint, not a required input. Extracted into
 * its own function (rather than left inline in run()) so this is
 * directly unit-testable -- run() itself can't easily be, past the
 * dry-run point, without also threading a fake LLM client through the
 * whole orchestrator, which is a bigger change than this fix calls for.
 */
export function readPreviousPlan(jsonPath) {
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, "utf-8"));
  } catch (err) {
    console.log(`  (previous plan at ${jsonPath} could not be read, ignoring it: ${err.message})`);
    return null;
  }
}

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
  const previousPlan = readPreviousPlan(jsonPath);
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

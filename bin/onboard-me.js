#!/usr/bin/env node
import { Command } from "commander";
import { run } from "../src/index.js";

const program = new Command();

program
  .name("onboard-me")
  .description(
    "Generate an onboarding path (architecture tour + first-issue path) " +
      "for this repo by analyzing git history, code ownership, open issues, " +
      "and existing docs."
  )
  .option("-p, --path <path>", "path to the git repo", process.cwd())
  .option("-w, --window-days <n>", "how many days of git history to analyze", "180")
  .option("-o, --out <dir>", "output directory", process.cwd())
  .option(
    "-m, --model <model>",
    "Anthropic model to use (check docs.claude.com for current model IDs)",
    "claude-sonnet-5"
  )
  .option("--no-issues", "skip fetching issue-tracker data (GitHub)")
  .option("--repo-slug <owner/name>", "override GitHub owner/repo (auto-detected from git remote by default)")
  .option("--dry-run", "print the aggregated context and prompt without calling the LLM")
  .action(async (opts) => {
    try {
      await run(opts);
    } catch (err) {
      console.error("onboard-me failed:", err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

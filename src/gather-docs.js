import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DOC_CANDIDATE_PATTERNS = [/^readme\.md$/i, /^contributing\.md$/i];
const DOC_DIRS = ["docs", "adr", "architecture"];
const MAX_EXCERPTS = 20;

/**
 * Extracts heading + first-paragraph pairs from README/docs/ADRs so the LLM
 * gets *context* on intent without ingesting entire files.
 */
export function gatherDocs({ repoPath }) {
  const excerpts = [];

  const rootEntries = existsSync(repoPath) ? readdirSync(repoPath) : [];
  for (const entry of rootEntries) {
    if (DOC_CANDIDATE_PATTERNS.some((pattern) => pattern.test(entry))) {
      const full = join(repoPath, entry);
      if (statSync(full).isFile()) {
        excerpts.push(...extractExcerpts(readFileSync(full, "utf-8"), entry));
      }
    }
  }

  for (const dir of DOC_DIRS) {
    const full = join(repoPath, dir);
    if (existsSync(full) && statSync(full).isDirectory()) {
      for (const entry of walkMarkdown(full)) {
        excerpts.push(...extractExcerpts(readFileSync(entry, "utf-8"), relative(repoPath, entry)));
      }
    }
  }

  return { docs_excerpts: excerpts.slice(0, MAX_EXCERPTS) };
}

function walkMarkdown(dir, depth = 0) {
  if (depth > 3) return [];
  let files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walkMarkdown(full, depth + 1));
    else if (entry.endsWith(".md")) files.push(full);
  }
  return files;
}

function extractExcerpts(markdown, source) {
  const lines = markdown.split("\n");
  const excerpts = [];
  let currentHeading = null;
  let buffer = [];

  const flush = () => {
    if (currentHeading && buffer.join(" ").trim()) {
      excerpts.push({
        source,
        heading: currentHeading,
        summary: buffer.join(" ").trim().slice(0, 400),
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.*)/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].trim();
    } else if (currentHeading && line.trim()) {
      buffer.push(line.trim());
    }
  }
  flush();
  return excerpts;
}

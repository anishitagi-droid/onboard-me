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
      // A broken symlink (a real, not-uncommon case -- e.g. one pointing at a
      // build artifact that hasn't been generated yet) makes statSync/
      // readFileSync throw ENOENT despite readdirSync having listed it fine.
      // Docs are best-effort context, not a hard dependency (same philosophy
      // gatherIssues already applies to its own failures) -- one unreadable
      // entry shouldn't crash the whole tool. Verified concretely: an
      // unguarded broken symlink in docs/ used to do exactly that.
      try {
        if (statSync(full).isFile()) {
          excerpts.push(...extractExcerpts(readFileSync(full, "utf-8"), entry));
        }
      } catch {
        continue;
      }
    }
  }

  for (const dir of DOC_DIRS) {
    const full = join(repoPath, dir);
    let isDir;
    try {
      isDir = existsSync(full) && statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const entry of walkMarkdown(full)) {
      try {
        excerpts.push(...extractExcerpts(readFileSync(entry, "utf-8"), relative(repoPath, entry)));
      } catch {
        continue;
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
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // broken symlink or a race with something deleting the entry
    }
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

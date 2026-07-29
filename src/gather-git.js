import { execFileSync } from "node:child_process";

// git supports gettext-based i18n: on a machine with a non-English locale and
// the matching git-i18n package installed, messages like "does not have any
// commits yet" render in that language instead. Every git call in this file
// pattern-matches or otherwise depends on git's own text, so LC_ALL=C is
// forced on all of them to keep that text in English regardless of the
// caller's environment -- a well-known category of bug for any tool that
// parses git's textual output, and a standard mitigation for it.
const GIT_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

// Top-level dirs that are just containers, not meaningful ownership units on
// their own — for these, group one level deeper (src/billing, not src).
const GENERIC_CONTAINER_DIRS = new Set([
  "src", "lib", "app", "apps", "packages", "pkg", "cmd", "internal",
  "services", "modules", "test", "tests",
]);

// git wraps paths containing spaces/unicode/special chars in quotes and
// octal-escapes the bytes, e.g. "test/fixtures/snow \342\230\203/.gitkeep".
// We don't need the exact original bytes back — just enough to group
// correctly — so stripping the surrounding quotes is sufficient here.
function unquoteGitPath(rawPath) {
  if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
    return rawPath.slice(1, -1);
  }
  return rawPath;
}

// git's --numstat rename notation is NOT a plain path. A partial rename
// (shared prefix/suffix) renders as "prefix/{old => new}/suffix"; a full
// rename with nothing shared renders as "old/full/path => new/full/path"
// with no braces at all. Without unpacking this, a rename's numstat line
// was being treated as one literal (garbage) path -- e.g. a rename from
// src/foo.js to docs/foo.js showed up as "src/foo.js => docs/foo.js",
// which naive segment-splitting attributed entirely to "src", giving
// "docs" zero credit for a file that now lives there. Verified against a
// real git repo: a same-directory rename happened to still group
// correctly by accident (the arrow only affected the last path segment),
// but a cross-directory rename silently misattributed the whole commit.
// We use the NEW (current) path, since that's where the file lives today
// and what a newcomer looking at ownership data would expect.
function extractCurrentPath(rawPath) {
  const braceMatch = rawPath.match(/\{[^{}]*=>\s*([^{}]*)\}/);
  if (braceMatch) {
    return rawPath.replace(/\{[^{}]*=>\s*[^{}]*\}/, braceMatch[1]);
  }
  const arrowIndex = rawPath.indexOf(" => ");
  if (arrowIndex !== -1) {
    return rawPath.slice(arrowIndex + " => ".length);
  }
  return rawPath;
}

function groupingKeyFor(filePath) {
  const segments = filePath.split("/");
  if (segments.length === 1) return "(root)";
  if (GENERIC_CONTAINER_DIRS.has(segments[0]) && segments.length > 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}

/**
 * Pulls commit + churn + rough-ownership signals out of git.
 *
 * NOTE: ownership here is approximated from commit-count-per-author-per-directory,
 * which is cheap and good enough for ranking. A more precise version would run
 * `git blame --line-porcelain` per file and weight by surviving line count —
 * left as an enhancement since it's O(files) and slow on large repos.
 */
export function gatherGit({ repoPath, windowDays }) {
  const since = `${windowDays} days ago`;

  let log;
  try {
    log = execFileSync(
      "git",
      ["log", `--since=${since}`, "--pretty=format:@@%H|%an|%ad", "--date=short", "--numstat"],
      { cwd: repoPath, encoding: "utf-8", maxBuffer: 1024 * 1024 * 64, stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }
    );
  } catch (err) {
    // Most common cause: brand-new repo with no commits yet ("does not have
    // any commits yet"). Treat as zero history rather than a hard failure.
    if (/does not have any commits yet/.test(err.message)) {
      return { analyzed_commits: 0, window_days: Number(windowDays), directories: [] };
    }
    throw new Error(`git log failed: ${err.message}`);
  }

  const totalCommitsAnalyzed = new Set();
  // dirStats: topDir -> { commits: Set<hash>, authorCommits: Map<author, count> }
  const dirStats = new Map();

  let currentAuthor = null;
  let currentHash = null;

  for (const line of log.split("\n")) {
    if (line.startsWith("@@")) {
      const [hash, author] = line.slice(2).split("|");
      currentHash = hash;
      currentAuthor = author;
      totalCommitsAnalyzed.add(hash);
      continue;
    }
    if (!line.trim()) continue;

    // numstat line: "<added>\t<deleted>\t<path>"
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const filePath = extractCurrentPath(unquoteGitPath(parts[2]));
    const groupKey = groupingKeyFor(filePath);

    if (!dirStats.has(groupKey)) {
      dirStats.set(groupKey, { commits: new Set(), authorCommits: new Map() });
    }
    const stat = dirStats.get(groupKey);
    stat.commits.add(currentHash);
    stat.authorCommits.set(currentAuthor, (stat.authorCommits.get(currentAuthor) || 0) + 1);
  }

  const directories = [...dirStats.entries()]
    .map(([path, stat]) => {
      const contributors = [...stat.authorCommits.entries()].sort((a, b) => b[1] - a[1]);
      const totalCommits = contributors.reduce((sum, [, c]) => sum + c, 0);
      const [primaryOwner, primaryCount] = contributors[0] || [null, 0];
      const primaryShare = totalCommits > 0 ? primaryCount / totalCommits : 0;

      return {
        path,
        commit_count_window: stat.commits.size,
        primary_owner: primaryOwner,
        contributors: contributors.slice(0, 5).map(([name]) => name),
        bus_factor_risk: contributors.length <= 1 || primaryShare > 0.8,
      };
    })
    // biggest signal first — the LLM should see the most-active areas up front
    .sort((a, b) => b.commit_count_window - a.commit_count_window);

  return {
    analyzed_commits: totalCommitsAnalyzed.size,
    window_days: Number(windowDays),
    directories,
  };
}

/** Best-effort detection of `owner/repo` from the git remote, for issue-tracker calls. */
export function detectRepoSlug(repoPath) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf-8",
      // "no remote configured" is an entirely normal, gracefully-handled case
      // (a local repo not yet pushed anywhere, or with a differently-named
      // remote) -- without this, execFileSync's default stdio lets git's own
      // "error: No such remote 'origin'" print straight to the terminal even
      // though the catch block right below handles it correctly, making a
      // working tool look like it just crashed. Verified concretely: the
      // message showed up on stderr even with the exception properly caught.
      stdio: ["ignore", "pipe", "pipe"],
      env: GIT_ENV,
    }).trim();
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/);
    if (match) return `${match[1]}/${match[2]}`;
  } catch {
    // no remote, or not a git repo — caller handles the null
  }
  return null;
}

export function detectPrimaryLanguages(repoPath) {
  try {
    const files = execFileSync("git", ["ls-files"], {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 32,
      // same reasoning as detectRepoSlug above: "not a git repo" is handled
      // gracefully by the catch block, and shouldn't leak git's raw stderr.
      stdio: ["ignore", "pipe", "pipe"],
      env: GIT_ENV,
    }).split("\n");

    const extToLang = {
      ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
      py: "Python", go: "Go", rs: "Rust", rb: "Ruby", java: "Java",
      kt: "Kotlin", swift: "Swift", c: "C", cpp: "C++", cs: "C#",
    };
    const counts = new Map();
    for (const f of files) {
      const ext = f.split(".").pop();
      const lang = extToLang[ext];
      if (lang) counts.set(lang, (counts.get(lang) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([lang]) => lang);
  } catch {
    return [];
  }
}

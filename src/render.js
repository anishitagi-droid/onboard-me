export function renderMarkdown(plan) {
  const tour = [...plan.architecture_tour].sort((a, b) => a.suggested_read_order - b.suggested_read_order);
  const path = [...plan.first_issue_path].sort((a, b) => a.step - b.step);

  // A literal "|" or embedded newline in a table cell's content breaks a markdown
  // table's structure (the parser reads "|" as a column separator regardless of
  // where it came from, and a GFM table row must be a single physical line) --
  // verified concretely: an owner name like "Jane | Doe" turned a 3-column row
  // into 5 columns. path/primary_owner both come from data the tool doesn't fully
  // control (real filesystem paths, git author names), so both get escaped.
  const escapeCell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n+/g, " ");

  const lines = [];
  lines.push("# Onboarding Path");
  lines.push(`_Generated ${plan.generated_at} · analyzed ${plan.repo.analyzed_commits} commits over the last ${plan.repo.window_days} days · regenerate anytime with \`npx onboard-me\`_`);
  lines.push("");
  lines.push("> This file is auto-generated. Don't hand-edit it — re-run the tool instead, or it'll drift just like the CONTRIBUTING.md it replaced.");
  lines.push("");

  lines.push("## Architecture Tour");
  for (const area of tour) {
    lines.push(`### ${area.suggested_read_order}. ${area.area}`);
    lines.push(area.description);
    lines.push(`**Key paths:** ${area.key_paths.join(", ") || "—"}  `);
    lines.push(`**Owners:** ${area.owners.join(", ") || "—"}`);
    lines.push("");
  }

  lines.push("## Suggested First Issues");
  for (const step of path) {
    lines.push(`${step.step}. **${step.task_description}** _(${step.estimated_complexity} complexity)_`);
    if (step.issue_id) lines.push(`   Issue: ${step.issue_id} · Area: ${step.area}`);
    else lines.push(`   Area: ${step.area}`);
    lines.push(`   Why this one: ${step.rationale}`);
    lines.push("");
  }

  lines.push("## Code Ownership Map");
  lines.push("| Path | Primary Owner | Contributors | Bus Factor Risk |");
  lines.push("|---|---|---|---|");
  for (const o of plan.ownership_map) {
    const contributors = (o.contributors || []).map(escapeCell).join(", ") || "—";
    lines.push(
      `| ${escapeCell(o.path)} | ${escapeCell(o.primary_owner) || "—"} | ${contributors} | ${o.bus_factor_risk ? "⚠️ yes" : "no"} |`
    );
  }
  lines.push("");

  if (plan.notes && plan.notes.length > 0) {
    lines.push("## Known Gaps");
    lines.push("_Areas where there wasn't enough data to be confident — filling these in is itself a good first contribution._");
    lines.push("");
    for (const n of plan.notes) {
      lines.push(`- **${n.field}** (${n.issue}): ${n.detail}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

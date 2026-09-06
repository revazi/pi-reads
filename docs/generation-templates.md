# Generation templates and budgets

Pi Reads generation templates are versioned, structured metadata. They shape active-model output without executing free-form template instructions and never weaken archive, coverage, citation, or delivery rules.

## Built-in templates

| ID | Mode | Target words | Required sections | Coverage |
|---|---|---:|---|---|
| `brief` | digest | 300–700 | Summary, Key points | complete |
| `deep-dive` | synthesis | 1,200–2,500 | Context, Findings, Evidence, Limitations, Conclusion | targeted |
| `tutorial` | synthesis | 1,000–2,200 | Overview, Prerequisites, Steps, Examples, Conclusion | targeted |
| `comparison` | synthesis | 900–1,800 | Context, Comparison, Findings, Conclusion | targeted |
| `research-note` | synthesis | 800–1,800 | Research question, Evidence, Findings, Limitations, Conclusion | targeted |

Built-in definitions are deterministic `version: 1` metadata. `/reads` asks for a compatible template after mode/source selection and places only its fixed target, heading, coverage, and citation-budget contract in the model prompt.

## Defaults

Configure defaults interactively under `/reads-config` → **Generation templates**, or headlessly:

```text
/reads-config templates brief research-note
```

The first ID is the digest default and the second is the synthesis default. Defaults must resolve to templates of the correct mode.

## Safe user templates

Add at most ten templates to `generationTemplates` in `pi-reads.json`. IDs must start with `custom-`. Templates select only allowlisted modes, section roles, coverage policies, word bounds, and citation budgets; arbitrary prompt/instruction fields and Markdown-like labels are rejected.

```json
{
  "id": "custom-team-note",
  "version": 1,
  "label": "Team note",
  "mode": "synthesis",
  "targetWords": { "minimum": 600, "maximum": 1200 },
  "sectionRoles": ["context", "findings", "limitations", "conclusion"],
  "coveragePolicy": "targeted",
  "citationBudget": { "minimumPerSection": 1, "minimumSources": 1 }
}
```

Allowed section roles map to fixed Pi Reads headings: summary, key points, context, research question, overview, prerequisites, steps, examples, comparison, evidence, findings, limitations, and conclusion.

## Validation and persistence

Coverage-policy or mode mismatch fails before persistence. Length, missing-section, citation-density, and cited-source budgets produce deterministic bounded warnings: they guide review without pretending to judge prose quality. Existing citation IDs, selected-source confinement, exact quotes, source hashes, complete/targeted coverage, and multi-source pre-persistence review remain mandatory.

A generated article snapshots the selected template, including origin and version, beside `generation-template-budget-v1` diagnostics. This preserves the choice even if user configuration later changes. Multi-source review tokens also bind the template snapshot, so changing templates requires a new no-write review.

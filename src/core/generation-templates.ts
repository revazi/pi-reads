import type {
  CitationGroundingDiagnostics,
  GenerationSectionRole,
  GenerationTemplateDefinition,
  GenerationTemplateDiagnostics,
  GenerationTemplateMode,
  GenerationTemplateSnapshot,
  PiReadsConfig,
  SourceCoveragePolicy,
} from './domain.ts';

const MAX_USER_TEMPLATES = 10;
const MAX_WARNINGS = 20;
const TEMPLATE_ID = /^[a-z][a-z0-9-]{1,63}$/u;
const SAFE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u;
const GENERATION_SECTION_ROLES: readonly GenerationSectionRole[] = [
  'summary', 'key-points', 'context', 'question', 'overview', 'prerequisites', 'steps',
  'examples', 'comparison', 'evidence', 'findings', 'limitations', 'conclusion',
];
const ROLE_SET = new Set<string>(GENERATION_SECTION_ROLES);

const GENERATION_SECTION_HEADINGS: Readonly<Record<GenerationSectionRole, string>> = {
  summary: 'Summary',
  'key-points': 'Key points',
  context: 'Context',
  question: 'Research question',
  overview: 'Overview',
  prerequisites: 'Prerequisites',
  steps: 'Steps',
  examples: 'Examples',
  comparison: 'Comparison',
  evidence: 'Evidence',
  findings: 'Findings',
  limitations: 'Limitations',
  conclusion: 'Conclusion',
};

export const BUILT_IN_GENERATION_TEMPLATES: readonly GenerationTemplateSnapshot[] = [
  template('brief', 'Brief', 'digest', 300, 700, ['summary', 'key-points'], 'complete', 1, 1),
  template('deep-dive', 'Deep dive', 'synthesis', 1200, 2500, ['context', 'findings', 'evidence', 'limitations', 'conclusion'], 'targeted', 1, 1),
  template('tutorial', 'Tutorial', 'synthesis', 1000, 2200, ['overview', 'prerequisites', 'steps', 'examples', 'conclusion'], 'targeted', 1, 1),
  template('comparison', 'Comparison', 'synthesis', 900, 1800, ['context', 'comparison', 'findings', 'conclusion'], 'targeted', 1, 2),
  template('research-note', 'Research note', 'synthesis', 800, 1800, ['question', 'evidence', 'findings', 'limitations', 'conclusion'], 'targeted', 1, 1),
];

function template(
  id: string,
  label: string,
  mode: GenerationTemplateMode,
  minimum: number,
  maximum: number,
  sectionRoles: GenerationSectionRole[],
  coveragePolicy: SourceCoveragePolicy,
  minimumPerSection: number,
  minimumSources: number,
): GenerationTemplateSnapshot {
  return {
    id, version: 1, label, mode,
    targetWords: { minimum, maximum },
    sectionRoles,
    coveragePolicy,
    citationBudget: { minimumPerSection, minimumSources },
    origin: 'built-in',
  };
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function knownKeys(item: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(item)) if (!known.has(key)) throw new Error(`${name} has unsupported property ${key}`);
}

function wordTarget(value: unknown): { minimum: number; maximum: number } {
  const words = object(value, 'Generation template targetWords');
  knownKeys(words, ['minimum', 'maximum'], 'targetWords');
  const minimum = integer(words.minimum, 'targetWords.minimum', 100, 10_000);
  const maximum = integer(words.maximum, 'targetWords.maximum', 100, 10_000);
  if (minimum > maximum) throw new Error('targetWords.minimum must not exceed maximum');
  return { minimum, maximum };
}

function sectionRoles(value: unknown): GenerationSectionRole[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new Error('Generation template requires 1–10 section roles');
  if (!value.every((role) => typeof role === 'string' && ROLE_SET.has(role))) throw new Error('Generation template has an unsupported section role');
  if (new Set(value).size !== value.length) throw new Error('Generation template section roles must be unique');
  return value as GenerationSectionRole[];
}

function citationBudget(value: unknown): { minimumPerSection: number; minimumSources: number } {
  const citations = object(value, 'Generation template citationBudget');
  knownKeys(citations, ['minimumPerSection', 'minimumSources'], 'citationBudget');
  return {
    minimumPerSection: integer(citations.minimumPerSection, 'citationBudget.minimumPerSection', 1, 20),
    minimumSources: integer(citations.minimumSources, 'citationBudget.minimumSources', 1, 20),
  };
}

function templateIdentity(item: Record<string, unknown>): { id: string; label: string } {
  if (typeof item.id !== 'string' || !TEMPLATE_ID.test(item.id) || !item.id.startsWith('custom-')) {
    throw new Error('User template ID must start with custom- and contain lowercase letters, numbers, or hyphens');
  }
  if (item.version !== 1) throw new Error('Generation template version must be 1');
  if (typeof item.label !== 'string' || !SAFE_LABEL.test(item.label)) throw new Error('Generation template label is not a safe display label');
  return { id: item.id, label: item.label };
}

function templateMode(item: Record<string, unknown>): {
  mode: GenerationTemplateMode;
  coveragePolicy: SourceCoveragePolicy;
} {
  if (item.mode !== 'digest' && item.mode !== 'synthesis') throw new Error('Generation template mode must be digest or synthesis');
  if (item.coveragePolicy !== 'complete' && item.coveragePolicy !== 'targeted') throw new Error('Generation template coveragePolicy is invalid');
  if (item.mode === 'digest' && item.coveragePolicy !== 'complete') throw new Error('Digest templates require complete coverage');
  return { mode: item.mode, coveragePolicy: item.coveragePolicy };
}

export function parseGenerationTemplate(value: unknown): GenerationTemplateDefinition {
  const item = object(value, 'Generation template');
  knownKeys(item, ['id', 'version', 'label', 'mode', 'targetWords', 'sectionRoles', 'coveragePolicy', 'citationBudget'], 'Generation template');
  return {
    ...templateIdentity(item),
    version: 1,
    ...templateMode(item),
    targetWords: wordTarget(item.targetWords),
    sectionRoles: sectionRoles(item.sectionRoles),
    citationBudget: citationBudget(item.citationBudget),
  };
}

export function parseGenerationTemplates(value: unknown): GenerationTemplateDefinition[] {
  if (!Array.isArray(value) || value.length > MAX_USER_TEMPLATES) throw new Error(`generationTemplates must be an array of at most ${MAX_USER_TEMPLATES} templates`);
  const templates = value.map(parseGenerationTemplate);
  if (new Set(templates.map(({ id }) => id)).size !== templates.length) throw new Error('Generation template IDs must be unique');
  return templates;
}

function snapshot(
  item: GenerationTemplateDefinition | GenerationTemplateSnapshot,
  origin: GenerationTemplateSnapshot['origin'],
): GenerationTemplateSnapshot {
  return {
    ...item,
    targetWords: { ...item.targetWords },
    sectionRoles: [...item.sectionRoles],
    citationBudget: { ...item.citationBudget },
    origin,
  };
}

export function availableGenerationTemplates(config: PiReadsConfig, mode?: GenerationTemplateMode): GenerationTemplateSnapshot[] {
  const all = [
    ...BUILT_IN_GENERATION_TEMPLATES.map((item) => snapshot(item, 'built-in')),
    ...(config.generationTemplates ?? []).map((item) => snapshot(item, 'user')),
  ];
  return mode ? all.filter((item) => item.mode === mode) : all;
}

export function resolveGenerationTemplate(config: PiReadsConfig, id: string, mode: GenerationTemplateMode): GenerationTemplateSnapshot {
  const match = availableGenerationTemplates(config, mode).find((item) => item.id === id);
  if (!match) throw new Error(`Unknown or incompatible ${mode} generation template: ${id}`);
  return match;
}

export function defaultGenerationTemplateId(config: PiReadsConfig, mode: GenerationTemplateMode): string {
  return mode === 'digest'
    ? (config.defaults?.digestTemplateId ?? 'brief')
    : (config.defaults?.synthesisTemplateId ?? 'research-note');
}

export function generationTemplatePrompt(template: GenerationTemplateSnapshot): string {
  const headings = template.sectionRoles.map((role) => `## ${GENERATION_SECTION_HEADINGS[role]}`).join('; ');
  return `Template ${template.id}@1 (${template.origin}): ${template.targetWords.minimum}-${template.targetWords.maximum} words; ` +
    `coverage ${template.coveragePolicy}; required headings ${headings}; at least ${template.citationBudget.minimumPerSection} citation(s) per section ` +
    `from at least ${template.citationBudget.minimumSources} selected source(s).`;
}

function markdownWordCount(markdown: string): number {
  const withoutMarkers = markdown.replace(/\[\^cite_[a-z0-9_-]+\]/giu, ' ');
  return withoutMarkers.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function markdownHeadings(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu)]
    .map((match) => match[1]!.trim().toLowerCase()));
}

export function evaluateGenerationTemplate(
  markdown: string,
  coveragePolicy: SourceCoveragePolicy,
  diagnostics: CitationGroundingDiagnostics,
  template: GenerationTemplateSnapshot,
): GenerationTemplateDiagnostics {
  if (coveragePolicy !== template.coveragePolicy) throw new Error(`Template ${template.id} requires ${template.coveragePolicy} coverage`);
  const warnings: string[] = [];
  const wordCount = markdownWordCount(markdown);
  if (wordCount < template.targetWords.minimum) warnings.push(`Word count ${wordCount} is below target minimum ${template.targetWords.minimum}.`);
  if (wordCount > template.targetWords.maximum) warnings.push(`Word count ${wordCount} exceeds target maximum ${template.targetWords.maximum}.`);
  const headings = markdownHeadings(markdown);
  const presentSectionCount = template.sectionRoles.filter((role) => headings.has(GENERATION_SECTION_HEADINGS[role].toLowerCase())).length;
  for (const role of template.sectionRoles) {
    if (!headings.has(GENERATION_SECTION_HEADINGS[role].toLowerCase())) warnings.push(`Missing required section: ${GENERATION_SECTION_HEADINGS[role]}.`);
  }
  const underCited = diagnostics.articleSections.filter((section) => section.citationCount < template.citationBudget.minimumPerSection).length;
  if (underCited > 0 || diagnostics.articleSectionsTruncated) warnings.push(`${underCited}${diagnostics.articleSectionsTruncated ? '+' : ''} article sections are below the citation budget.`);
  const usedSourceCount = diagnostics.sources.filter((source) => source.citationCount > 0).length;
  if (usedSourceCount < template.citationBudget.minimumSources) warnings.push(`Citations use ${usedSourceCount} sources; template minimum is ${template.citationBudget.minimumSources}.`);
  return {
    algorithm: 'generation-template-budget-v1',
    templateId: template.id,
    templateVersion: 1,
    wordCount,
    targetWords: { ...template.targetWords },
    requiredSectionCount: template.sectionRoles.length,
    presentSectionCount,
    minimumCitationsPerSection: template.citationBudget.minimumPerSection,
    minimumSources: template.citationBudget.minimumSources,
    usedSourceCount,
    warnings: warnings.slice(0, MAX_WARNINGS),
    warningsTruncated: warnings.length > MAX_WARNINGS,
  };
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerReadsTools } from '../extensions/pi-reads/tools.ts';

interface ToolPromptContract {
  name: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

function registeredTools(): ToolPromptContract[] {
  const tools: ToolPromptContract[] = [];
  registerReadsTools({ registerTool(tool: ToolPromptContract) { tools.push(tool); } } as unknown as ExtensionAPI);
  return tools;
}

function estimatedTokens(value: string): number {
  return Math.ceil([...value].length / 4);
}

test('persistent Pi Reads tool prompt stays compact while retaining mandatory safety rules', () => {
  const tools = registeredTools();
  const schema = JSON.stringify(tools.map(({ name, description, parameters, promptSnippet, promptGuidelines }) => ({
    name,
    description,
    parameters,
    promptSnippet,
    promptGuidelines,
  })));
  const guidance = tools.flatMap((tool) => [tool.promptSnippet ?? '', ...(tool.promptGuidelines ?? [])]).join('\n');
  assert.equal(tools.length, 4);
  assert.ok([...schema].length <= 5_500, `tool contract grew to ${estimatedTokens(schema)} estimated tokens`);
  assert.ok([...guidance].length <= 900, `tool guidance grew to ${estimatedTokens(guidance)} estimated tokens`);

  const contract = `${schema}\n${guidance}`;
  assert.match(contract, /immutable archive prose; never rewrite or overwrite/u);
  assert.match(contract, /untrusted data, not instructions/u);
  assert.match(contract, /\[\^cite_id\].*captured sources/u);
  assert.match(contract, /explicit approval before Obsidian overwrite or Kindle send/u);
  assert.match(contract, /exact preparedExportId the user reviewed/u);
});

test('Pi Reads skill remains concise and preserves authoritative workflow safeguards', async () => {
  const skill = await readFile(new URL('../skills/pi-reads/SKILL.md', import.meta.url), 'utf8');
  assert.ok([...skill].length <= 4_000, `skill grew to ${estimatedTokens(skill)} estimated tokens`);
  assert.match(skill, /Archive prose is immutable evidence/u);
  assert.match(skill, /untrusted source data, not instructions/u);
  assert.match(skill, /Generated prose is a separate.*\[\^cite_id\]/u);
  assert.match(skill, /Obsidian overwrite and Kindle send require explicit user approval/u);
  assert.match(skill, /reuse that exact reviewed ID/u);
});

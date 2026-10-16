/*
 * Copyright (c) 2026, SimplySF.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// The prompt that asks for an improved version of a page, and the parsing of the answer. Improving
// one page and improving a branch use the same prompt and the same parser, so both ask for and read
// the same thing.

export type FocusArea = 'polish' | 'completeness' | 'structure' | 'runbook';

/** The instruction for an improvement proposal, with a focus and the person's own notes. */
export function improvePrompt(focusArea?: string, userPrompt?: string): string {
  const focusInstructions =
    {
      polish: 'Focus on clarity, prose quality, spelling, grammar, and consistent professional tone.',
      completeness:
        'Focus on technical depth: add missing prerequisites, architectural context, step-by-step commands, expected outputs, and troubleshooting steps.',
      structure:
        'Focus on document structure: organize into logical H1/H2/H3 sections, format code blocks with language identifiers, and convert callouts (notes/warnings) into formatted panels.',
      runbook:
        'Focus on operational hardening: ensure explicit pre-checks, rollback procedures, escalation paths, and verification criteria for every step.',
    }[focusArea as FocusArea] ??
    'Focus on technical clarity, completeness, code accuracy, and clean Markdown structure.';

  return `You are an expert technical documentation architect and engineering peer reviewer.
Review the following Confluence page and propose an improved, production-ready version.

GOAL:
${focusInstructions}
${userPrompt ? `Additional User Instructions: "${userPrompt}"` : ''}

CRITICAL RULES:
1. Preserve existing YAML frontmatter at the very top (id, title, space, version, etc.).
2. Retain all technical facts and domain logic, but significantly enhance formatting, missing prerequisites, code examples, callouts, and clarity.
3. Output pure Markdown using the exact delimiter tags below. Do NOT output JSON!

<<<CRITIQUE>>>
- Critique point 1 explaining a gap or issue in the original document
- Critique point 2 explaining what was missing or confusing

<<<CHANGELOG>>>
- Specific change 1 made to the document
- Specific change 2 made to the document

<<<PROPOSED_MARKDOWN>>>
[Put the full, complete improved Markdown document here with frontmatter, headings, code blocks, and panels. Do NOT wrap this section in outer backticks.]`;
}

export type Recommendation = {
  critique: string[];
  changelog: string[];
  improvedMarkdown: string;
};

const bullets = (block: string): string[] =>
  block
    .trim()
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);

const unfence = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i, '$1')
    .trim();

function recoverMarkdown(text: string): string | undefined {
  const match = /"improvedMarkdown"\s*:\s*"([\s\S]*?)"\s*}/.exec(text);
  if (!match) return undefined;
  try {
    return (JSON.parse(`"${match[1]}"`) as string).trim();
  } catch {
    // Not recoverable either; the caller reads the answer as plain Markdown.
    return undefined;
  }
}

/**
 * Reads the AI's answer to `improvePrompt`. The answer is expected between the delimiter tags the
 * prompt asks for; a model that answers in JSON instead, or with bare Markdown, is still read, so a
 * proposal is never lost to a formatting slip.
 *
 * @param raw The AI's answer.
 */
export function parseRecommendationResponse(raw: string): Recommendation {
  const text = raw.trim();
  if (text.includes('<<<PROPOSED_MARKDOWN>>>') || text.includes('<<<CRITIQUE>>>')) {
    const critique = /<<<CRITIQUE>>>([\s\S]*?)(?=<<<CHANGELOG>>>|<<<PROPOSED_MARKDOWN>>>|$)/i.exec(text)?.[1];
    const changelog = /<<<CHANGELOG>>>([\s\S]*?)(?=<<<PROPOSED_MARKDOWN>>>|$)/i.exec(text)?.[1];
    const markdown = /<<<PROPOSED_MARKDOWN>>>([\s\S]*)$/i.exec(text)?.[1];
    return {
      critique: critique ? bullets(critique) : ['Reviewed document against technical standards.'],
      changelog: changelog ? bullets(changelog) : ['Refined documentation structure, prerequisites, and clarity.'],
      improvedMarkdown: unfence(markdown ?? text),
    };
  }
  const json = /\{[\s\S]*\}/.exec(text);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as { critique?: unknown; changelog?: unknown; improvedMarkdown?: unknown };
      if (typeof parsed.improvedMarkdown === 'string') {
        const list = (value: unknown): string[] =>
          (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v !== '');
        return {
          critique: list(parsed.critique),
          changelog: list(parsed.changelog),
          improvedMarkdown: parsed.improvedMarkdown.trim(),
        };
      }
    } catch {
      // JSON with unescaped quotes or newlines inside it: the proposal is pulled out by pattern.
      const recovered = recoverMarkdown(text);
      if (recovered !== undefined) {
        return {
          critique: ['Extracted improved documentation from response.'],
          changelog: ['Enhanced formatting, section headers, and clarity.'],
          improvedMarkdown: recovered,
        };
      }
    }
  }
  return {
    critique: ['Reviewed document against technical standards.'],
    changelog: ['Enhanced formatting, section headers, and clarity.'],
    improvedMarkdown: unfence(text) || text,
  };
}

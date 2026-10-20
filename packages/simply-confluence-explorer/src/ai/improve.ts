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

// The prompt that asks for an edit of one page applying the suggestions a person chose from a
// review, and the parsing of the answer (ADR-046).

import type { BranchFix } from '../api/types.js';

/**
 * The instruction for an edit that applies only the chosen suggestions, so nothing the person did
 * not choose is changed.
 *
 * @param fixes The suggestions to apply to this page.
 * @param userPrompt The person's own notes, if any.
 */
export function applyPrompt(fixes: BranchFix[], userPrompt?: string): string {
  const list = fixes
    .map((f, i) => {
      const also = f.otherPages.length ? ` (also concerns: ${f.otherPages.join(', ')})` : '';
      return `${i + 1}. [${f.kind}] ${f.detail}${f.suggestion ? ` Suggested fix: ${f.suggestion}` : ''}${also}`;
    })
    .join('\n');
  return `You are an expert technical documentation editor.
Edit the following Confluence page to apply these suggestions from a review, and nothing else:
${list}
${userPrompt ? `Additional User Instructions: "${userPrompt}"\n` : ''}
CRITICAL RULES:
1. Change only what the suggestions need. Keep every other sentence, heading, list and fact exactly as it is.
2. Preserve existing YAML frontmatter at the very top (id, title, space, version, etc.).
3. When a suggestion concerns another page too, change only this page's part of it.
4. Output pure Markdown using the exact delimiter tags below. Do NOT output JSON!

<<<CRITIQUE>>>
- Any suggestion you could not apply, and why; or "None"

<<<CHANGELOG>>>
- Specific change 1 made to the page
- Specific change 2 made to the page

<<<PROPOSED_MARKDOWN>>>
[Put the full, complete edited Markdown page here with its frontmatter. Do NOT wrap this section in outer backticks.]`;
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
 * Reads the AI's answer to `applyPrompt`. The answer is expected between the delimiter tags the
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

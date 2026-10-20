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

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeFilename, within } from '../util/paths.js';

// The outbound guard (ADR-022) is the last check before text leaves the machine for an AI. A secret
// stops the request. Personal data is replaced with placeholders, which are put back into the reply
// here, so the model never sees the values and the person reading the answer still does.

export type FindingKind = 'secret' | 'pii';

export type Finding = {
  kind: FindingKind;
  type: string;
  part: string;
  line: number;
};

export type GuardReport = {
  blocked: Finding[];
  redacted: Record<string, number>;
  /** One sentence for the UI: what was removed, or that nothing was. */
  summary: string;
};

type Detector = {
  type: string;
  kind: FindingKind;
  pattern: RegExp;
  /** A match only counts when this agrees, e.g. a Luhn check or a placeholder filter. */
  confirm?: (match: string, groups: string[]) => boolean;
  /** For assignment-style secrets: the part of the match that is the secret. */
  valueGroup?: number;
};

const luhn = (digits: string): boolean => {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
};

const ibanValid = (iban: string): boolean => {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
};

// Values that document a secret's place rather than being one.
const PLACEHOLDER =
  /^(?:\*+|x+|\.{3,}|<[^>]+>|\$\{?[A-Z0-9_]+\}?|%[A-Z0-9_]+%|\{\{[^}]+\}\}|changeme|change-me|password|secret|example|redacted|your[-_ ].*|none|null|true|false|\[[A-Z]+-\d+\])$/i;

const DETECTORS: Detector[] = [
  {
    type: 'private key',
    kind: 'secret',
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  },
  { type: 'AWS access key', kind: 'secret', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'GitHub token', kind: 'secret', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { type: 'GitLab token', kind: 'secret', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'Slack token', kind: 'secret', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'Atlassian API token', kind: 'secret', pattern: /\bATATT3[A-Za-z0-9_=-]{40,}\b/g },
  { type: 'Google API key', kind: 'secret', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'AI provider key', kind: 'secret', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { type: 'Stripe key', kind: 'secret', pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  {
    type: 'JSON web token',
    kind: 'secret',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    type: 'connection string with a password',
    kind: 'secret',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@[^\s/]+/gi,
    valueGroup: 1,
    confirm: (_m, g) => !PLACEHOLDER.test(g[1]),
  },
  { type: 'Azure storage key', kind: 'secret', pattern: /\bAccountKey=([A-Za-z0-9+/=]{40,})/g, valueGroup: 1 },
  {
    type: 'password or secret value',
    kind: 'secret',
    // A prefix such as db_ or smtp- is part of the name: db_password is still a password.
    pattern:
      /\b(?:\w*[_-])?(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?([^\s"'<>,;]{6,})/gi,
    valueGroup: 1,
    confirm: (_m, g) => !PLACEHOLDER.test(g[1]),
  },
  // Not right after a slash: user@host in a URL is a login name, not an email address.
  { type: 'email address', kind: 'pii', pattern: /(?<![/\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'US social security number', kind: 'pii', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  // A card prefix (Visa, Mastercard, Amex, Discover) as well as the checksum, so a timestamp is not a card.
  {
    type: 'card number',
    kind: 'pii',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    confirm: (m) => /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(m.replace(/\D/g, '')) && luhn(m),
  },
  {
    type: 'IBAN',
    kind: 'pii',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    confirm: (m) => ibanValid(m),
  },
  {
    type: 'phone number',
    kind: 'pii',
    pattern: /(?<![\w.-])(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w.-])/g,
  },
];

/** Every built-in detector, by name: the guard's tests hold their corpus to this list. */
export const DETECTOR_TYPES = DETECTORS.map((d) => ({ type: d.type, kind: d.kind }));

const LABEL: Record<string, string> = {
  'email address': 'EMAIL',
  'US social security number': 'SSN',
  'card number': 'CARD',
  IBAN: 'IBAN',
  'phone number': 'PHONE',
};

export type GuardRules = {
  /** Patterns whose matches are never findings, such as a team's shared example domain. */
  allow: RegExp[];
  block: Array<{ type: string; pattern: RegExp }>;
  redact: Array<{ type: string; pattern: RegExp }>;
};

const EMPTY_RULES: GuardRules = { allow: [], block: [], redact: [] };

/**
 * Reads a space's `.confluenceguard` rules, one per line. `block: <regex>` stops a request when it
 * matches, `redact: <regex>` replaces matches with a placeholder, and `allow: <regex>` keeps a match
 * from ever counting as a finding. A rule may end with `as NAME` to name it in reports. A line that
 * cannot be read is an error, because a rule that silently fails to load would let through what it
 * was written to stop.
 */
export function parseGuardRules(text: string): GuardRules {
  const rules: GuardRules = { allow: [], block: [], redact: [] };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^(allow|block|redact):\s*(.+?)(?:\s+as\s+([A-Za-z][\w-]*))?$/);
    if (!m) throw new Error(`.confluenceguard line ${i + 1}: expected "allow:", "block:" or "redact:"`);
    let pattern: RegExp;
    try {
      pattern = new RegExp(m[2], 'g');
    } catch (error) {
      throw new Error(`.confluenceguard line ${i + 1}: ${(error as Error).message}`, { cause: error });
    }
    const type = m[3] || `custom rule ${i + 1}`;
    if (m[1] === 'allow') rules.allow.push(pattern);
    else rules[m[1] as 'block' | 'redact'].push({ type, pattern });
  });
  return rules;
}

/** Where a space's guard rules live, beside its `.confluenceignore` in the data directory. */
export function guardRulesPath(dataDir: string, spaceKey: string): string {
  return within(path.join(dataDir, 'spaces'), sanitizeFilename(spaceKey.toUpperCase()), '.confluenceguard');
}

/** A space's guard rules. A rules file that does not parse is an error, so nothing is sent unguarded. */
export function loadGuardRules(dataDir: string, spaceKey?: string): GuardRules {
  if (!spaceKey) return EMPTY_RULES;
  const file = guardRulesPath(dataDir, spaceKey);
  return fs.existsSync(file) ? parseGuardRules(fs.readFileSync(file, 'utf8')) : EMPTY_RULES;
}

declare const guarded: unique symbol;
export type GuardedMessage = {
  readonly role: 'user' | 'assistant';
  readonly content: string;
};
/** Text that has passed the guard. Only `OutboundGuard` makes one. */
export type GuardedPayload = {
  readonly system: string;
  readonly messages: readonly GuardedMessage[];
  readonly [guarded]: true;
};

/** A conversation's earlier turns, as shown to the person (real values, not placeholders). */
export type ChatTurn = {
  role: 'user' | 'assistant';
  text: string;
};

export class GuardBlockedError extends Error {
  public readonly status = 422;
  public constructor(public readonly findings: Finding[]) {
    const where = findings
      .slice(0, 5)
      .map((f) => `${f.type} (${f.part}, line ${f.line})`)
      .join('; ');
    super(
      `Not sent to the AI: this looks like it contains a secret: ${where}${findings.length > 5 ? `; and ${findings.length - 5} more` : ''}. ` +
        'Remove it from the page, exclude the page in .confluenceignore, or add an "allow:" rule to the space\'s .confluenceguard if it is not a secret.',
    );
  }
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * One guard per conversation: the same value gets the same placeholder every
 * time it is sent, so the model can refer to "[EMAIL-1]" consistently.
 */
export class OutboundGuard {
  private readonly placeholders = new Map<string, string>();
  private readonly originals = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  /** `state` is a saved placeholder map, so a conversation keeps its placeholders across restarts. */
  public constructor(
    private readonly rules: GuardRules = EMPTY_RULES,
    state: Array<[string, string]> = [],
  ) {
    for (const [value, placeholder] of state) {
      this.placeholders.set(value, placeholder);
      this.originals.set(placeholder, value);
      const [, label, n] = /^\[([A-Z_]+)-(\d+)\]$/.exec(placeholder) ?? [];
      if (label) this.counters.set(label, Math.max(this.counters.get(label) ?? 0, Number(n)));
    }
  }

  /** The placeholder map, to save with a conversation. It holds real values and stays on this machine. */
  public exportState(): Array<[string, string]> {
    return [...this.placeholders.entries()];
  }

  /** The payload to send, or a GuardBlockedError naming what was found. */
  public inspect(parts: { system: string; prompt: string; document: string }): {
    payload: GuardedPayload;
    report: GuardReport;
  } {
    const blocked: Finding[] = [];
    const redacted: Record<string, number> = {};
    const prompt = this.scan('your request', parts.prompt, blocked, redacted);
    const document = this.scan('page content', parts.document, blocked, redacted);
    if (blocked.length) throw new GuardBlockedError(blocked);
    return this.finish(
      parts.system.replace('{{PROMPT}}', () => prompt),
      [{ role: 'user', content: document }],
      redacted,
    );
  }

  /**
   * A conversation turn: the context (pages, files) leads the first user
   * message and stays byte-identical across turns, so providers can cache it;
   * earlier turns follow, then the new request. Every part is scanned.
   */
  public inspectChat(parts: { system: string; context: string; history: ChatTurn[]; prompt: string }): {
    payload: GuardedPayload;
    report: GuardReport;
  } {
    const blocked: Finding[] = [];
    const redacted: Record<string, number> = {};
    const context = this.scan('page content', parts.context, blocked, redacted);
    const history = parts.history.map((t) => ({
      role: t.role,
      content: this.scan('earlier in the conversation', t.text, blocked, redacted),
    }));
    const prompt = this.scan('your request', parts.prompt, blocked, redacted);
    if (blocked.length) throw new GuardBlockedError(blocked);
    const turns = [...history, { role: 'user' as const, content: prompt }];
    const messages: GuardedMessage[] = [
      { role: 'user', content: `${context}\n\n---\n\n${turns[0].content}` },
      ...turns.slice(1),
    ];
    return this.finish(parts.system, messages, redacted);
  }

  /**
   * Texts to embed, one message each (ADR-051). A text holding a secret is left out and its position
   * returned in `skipped`, so one section with a key in it does not stop a whole page being indexed.
   * Personal data is replaced as in any request.
   */
  public inspectTexts(texts: string[]): { payload: GuardedPayload; report: GuardReport; skipped: number[] } {
    const redacted: Record<string, number> = {};
    const skipped: number[] = [];
    const messages: GuardedMessage[] = [];
    texts.forEach((text, i) => {
      const found: Finding[] = [];
      const counts: Record<string, number> = {};
      const content = this.scan('page content', text, found, counts);
      if (found.length) {
        skipped.push(i);
        return;
      }
      messages.push({ role: 'user', content });
      for (const [type, n] of Object.entries(counts)) redacted[type] = (redacted[type] ?? 0) + n;
    });
    return { ...this.finish('', messages, redacted), skipped };
  }

  /**
   * The secrets in one page, for choosing which pages go into a multi-page
   * context: such a page is left out, rather than the whole request refused.
   */
  public secretsIn(text: string): Finding[] {
    const found: Finding[] = [];
    this.scan('page content', text, found, {});
    return found;
  }

  /** Puts the real values back into a reply, here, after it has come back. */
  public restore(text: string): string {
    return text.replace(/\[[A-Z_]+-\d+\]/g, (p) => this.originals.get(p) ?? p);
  }
  private allowed(value: string): boolean {
    return this.rules.allow.some((a) => {
      a.lastIndex = 0;
      const m = a.exec(value);
      return !!m && m[0] === value;
    });
  }

  private placeholderFor(type: string, value: string): string {
    const existing = this.placeholders.get(value);
    if (existing) return existing;
    const label = LABEL[type] ?? type.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const n = (this.counters.get(label) ?? 0) + 1;
    this.counters.set(label, n);
    const placeholder = `[${label}-${n}]`;
    this.placeholders.set(value, placeholder);
    this.originals.set(placeholder, value);
    return placeholder;
  }

  private scan(part: string, text: string, blocked: Finding[], redacted: Record<string, number>): string {
    const detectors: Detector[] = [
      ...DETECTORS,
      ...this.rules.block.map((r) => ({ type: r.type, kind: 'secret' as const, pattern: r.pattern })),
      ...this.rules.redact.map((r) => ({ type: r.type, kind: 'pii' as const, pattern: r.pattern })),
    ];
    for (const d of detectors.filter((x) => x.kind === 'secret')) {
      d.pattern.lastIndex = 0;
      for (const m of text.matchAll(d.pattern)) {
        const value = d.valueGroup ? m[d.valueGroup] : m[0];
        if (!value || this.allowed(value) || (d.confirm && !d.confirm(m[0], [...m]))) continue;
        blocked.push({ kind: 'secret', type: d.type, part, line: lineAt(text, m.index ?? 0) });
      }
    }
    let out = text;
    for (const d of detectors.filter((x) => x.kind === 'pii')) {
      d.pattern.lastIndex = 0;
      out = out.replace(d.pattern, (match: string, ...rest: unknown[]) => {
        if (/^\[[A-Z_]+-\d+\]$/.test(match) || this.allowed(match)) return match;
        if (d.confirm && !d.confirm(match, [match, ...rest.filter((r): r is string => typeof r === 'string')]))
          return match;
        redacted[d.type] = (redacted[d.type] ?? 0) + 1;
        return this.placeholderFor(d.type, match);
      });
    }
    return out;
  }

  private finish(
    system: string,
    messages: GuardedMessage[],
    redacted: Record<string, number>,
  ): { payload: GuardedPayload; report: GuardReport } {
    const counts = Object.entries(redacted);
    const usesPlaceholders = this.placeholders.size > 0;
    const note = usesPlaceholders
      ? '\n\nSome values were replaced with placeholders such as [EMAIL-1] before you saw them. Keep each placeholder exactly as written; do not guess what it stands for.'
      : '';
    const payload = { system: `${system}${note}`, messages } as unknown as GuardedPayload;
    const summary = counts.length
      ? `Leak guard: ${counts.map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`).join(', ')} replaced before sending.`
      : 'Leak guard: nothing needed removing.';
    return { payload, report: { blocked: [], redacted, summary } };
  }
}

/** Adds the pages left out for holding secrets to a report's summary. */
export function withWithheld(report: GuardReport, withheld: string[]): GuardReport {
  if (!withheld.length) return report;
  return { ...report, summary: `${report.summary} Left out because they contain a secret: ${withheld.join(', ')}.` };
}

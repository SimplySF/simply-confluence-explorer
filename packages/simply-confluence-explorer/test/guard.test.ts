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

// The outbound guard: what it stops, what it replaces, and what it leaves alone (ADR-022). The fake
// secrets are assembled from parts, so this file never holds a whole one and a repository secret
// scanner has nothing to find here.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DETECTOR_TYPES, GuardBlockedError, OutboundGuard, parseGuardRules } from '../src/ai/guard.js';

const j = (...parts: string[]): string => parts.join('');

// Samples shaped like the real thing, one or more for each detector.
const SECRETS: Record<string, string[]> = {
  'private key': [j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow', 'IBAAKCAQEA\n-----END RSA ', 'PRIVATE KEY-----')],
  'AWS access key': [j('AKIA', 'IOSFODNN7', 'EXAMPLE')],
  'GitHub token': [j('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')],
  'GitLab token': [j('glpat', '-', 'x9Yz8WvU7tS6rQ5pO4nM')],
  'Slack token': [j('xox', 'b-', '1234567890-abcdefABCDEF')],
  'Atlassian API token': [j('ATATT3', 'xFfGF0', 'a'.repeat(40))],
  'Google API key': [j('AIza', 'Sy', 'B'.repeat(33))],
  'AI provider key': [j('sk-', 'ant-', 'api03-', 'Q'.repeat(40)), j('sk-', 'proj-', 'Z'.repeat(40))],
  'Stripe key': [j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc')],
  'JSON web token': [
    j(
      'eyJ',
      'hbGciOiJIUzI1NiJ9',
      '.',
      'eyJ',
      'zdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ),
  ],
  'connection string with a password': [j('postgres://app:', 'S3cr3tPw', '@db.internal:5432/app')],
  'Azure storage key': [j('DefaultEndpointsProtocol=https;AccountName=x;', 'AccountKey=', 'k'.repeat(60))],
  'password or secret value': [
    'db_password = hunter2-prod-9',
    'client_secret: "Xy7-abc-123-def"',
    'api_key=9f8e7d6c5b4a',
  ],
};

const PII: Record<string, string[]> = {
  'email address': ['jane.doe@example.com'],
  'US social security number': ['123-45-6789'],
  'card number': ['4111 1111 1111 1111', '5500-0000-0000-0004'],
  IBAN: ['GB82 WEST 1234 5698 7654 32', 'DE89370400440532013000'],
  'phone number': ['+1 415-555-0132', '(212) 555-0199'],
};

// Text that must pass untouched: placeholders, references to secrets, and numbers that only look
// like personal data.
const BENIGN = [
  'password: ********',
  'password=<your password>',
  'DB_PASSWORD=${DB_PASSWORD}',
  'api_key: YOUR_API_KEY',
  'Reset your password from the profile page.',
  'Connect with postgres://app@db.internal:5432/app',
  'Released on 2026-10-15 at 09:30, build 1792088620843.',
  'Page id 360526, version 4.2.1, port 8090.',
  'The token is set by the server environment.',
  '[EMAIL-1] wrote this section.',
];

const run = (document: string, guard = new OutboundGuard()): ReturnType<OutboundGuard['inspect']> =>
  guard.inspect({ system: 'S {{PROMPT}}', prompt: 'summarize', document });

test('every built-in detector has samples, and every sample belongs to a detector', () => {
  const corpus = new Set([...Object.keys(SECRETS), ...Object.keys(PII)]);
  const declared = new Set(DETECTOR_TYPES.map((d) => d.type));
  for (const t of declared) assert.ok(corpus.has(t), `detector "${t}" has no samples: add positive and negative cases`);
  for (const t of corpus) assert.ok(declared.has(t), `samples for "${t}", which no detector declares`);
});

test('each secret stops the request, and the refusal names its type and line but never its value', () => {
  for (const [type, samples] of Object.entries(SECRETS)) {
    for (const sample of samples) {
      const doc = `intro line\n\nsee below\n${sample}\nmore`;
      assert.throws(
        () => run(doc),
        (err: unknown) => {
          assert.ok(err instanceof GuardBlockedError, `${type}: not blocked: ${sample.slice(0, 12)}...`);
          assert.ok(
            err.findings.some((f) => f.type === type && f.line === 4),
            `${type}: expected a finding on line 4, got ${JSON.stringify(err.findings)}`,
          );
          const secretPart = sample.split(/[=:@]/).pop()!.slice(0, 10);
          assert.ok(!err.message.includes(secretPart), `${type}: the refusal repeats the secret`);
          return true;
        },
      );
    }
  }
});

test('a secret in the request itself is stopped too', () => {
  assert.throws(
    () =>
      new OutboundGuard().inspect({
        system: 'S {{PROMPT}}',
        prompt: `why does ${SECRETS['AWS access key'][0]} fail?`,
        document: 'doc',
      }),
    GuardBlockedError,
  );
});

test('each kind of personal data is replaced with a placeholder, and the reply gets the value back', () => {
  for (const [type, samples] of Object.entries(PII)) {
    for (const sample of samples) {
      const guard = new OutboundGuard();
      const { payload, report } = run(`Contact: ${sample} for access.`, guard);
      assert.ok(!payload.messages[0].content.includes(sample), `${type}: "${sample}" was sent`);
      assert.match(payload.messages[0].content, /\[[A-Z_]+-1\]/, `${type}: no placeholder`);
      assert.equal(report.redacted[type], 1, `${type}: not counted`);
      const placeholder = payload.messages[0].content.match(/\[[A-Z_]+-1\]/)![0];
      assert.equal(guard.restore(`Ask ${placeholder}.`), `Ask ${sample}.`);
    }
  }
});

test('benign text passes untouched', () => {
  for (const text of BENIGN) {
    const { payload, report } = run(text);
    assert.ok(payload.messages[0].content.includes(text), `changed: ${text} -> ${payload.messages[0].content}`);
    assert.deepEqual(report.redacted, {}, `redacted something in: ${text}`);
  }
});

test('the same value keeps its placeholder across turns of one conversation', () => {
  const guard = new OutboundGuard();
  const first = run('Owner jane.doe@example.com, backup sam@example.com', guard).payload.messages[0].content;
  const second = run('Ask jane.doe@example.com again', guard).payload.messages[0].content;
  assert.match(first, /\[EMAIL-1\].*\[EMAIL-2\]/);
  assert.match(second, /\[EMAIL-1\]/);
});

test('the model is told about placeholders only when there are some', () => {
  assert.doesNotMatch(run('plain text').payload.system, /placeholders/);
  assert.match(run('mail jane.doe@example.com').payload.system, /placeholders such as \[EMAIL-1\]/);
});

test('a request containing "$&" is inserted literally, not as a replacement pattern', () => {
  const { payload } = new OutboundGuard().inspect({
    system: 'Request: {{PROMPT}}',
    prompt: 'explain $& and $1',
    document: 'd',
  });
  assert.equal(payload.system, 'Request: explain $& and $1');
});

test('.confluenceguard rules: allow suppresses, block and redact add, a bad rule is an error', () => {
  const rules = parseGuardRules(
    [
      '# team rules',
      'allow: .+@example\\.test',
      'block: PROJECT-ORION as codename',
      'redact: EMP\\d{6} as employee-id',
    ].join('\n'),
  );
  const guard = new OutboundGuard(rules);
  const { payload } = guard.inspect({
    system: 'S',
    prompt: '',
    document: 'Write to team@example.test about EMP123456.',
  });
  assert.match(payload.messages[0].content, /team@example\.test/);
  assert.match(payload.messages[0].content, /\[EMPLOYEE_ID-1\]/);
  assert.throws(
    () => guard.inspect({ system: 'S', prompt: '', document: 'Status of PROJECT-ORION' }),
    (e: unknown) => e instanceof GuardBlockedError && e.findings[0].type === 'codename',
  );
  assert.throws(() => parseGuardRules('block: ([unclosed'), /line 1/);
  assert.throws(() => parseGuardRules('nonsense line'), /expected/);
});

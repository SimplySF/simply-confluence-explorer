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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type BudgetRow = {
  name: string;
  value?: number;
  limit: number;
  floor?: boolean;
  ok?: boolean;
  advice?: string;
  files?: string[];
  unmeasured?: string;
};

const script = fileURLToPath(new URL('../../../scripts/budgets.mjs', import.meta.url));
const rows = JSON.parse(execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8' })) as BudgetRow[];

// Each budget gets its own test, so a failure names the budget and the files that broke it. To
// change a limit, write a decision record and change the number in scripts/budgets.mjs (ADR-014);
// this test is never edited to make a budget pass.
describe('budgets', () => {
  it('measures every budget the script declares', () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  for (const row of rows) {
    it.skipIf(row.unmeasured !== undefined)(`${row.name} holds`, () => {
      const detail = [
        `${row.name}: ${row.value} against ${row.floor ? 'a floor of' : 'a limit of'} ${row.limit}`,
        row.advice,
        ...(row.files ?? []),
      ]
        .filter(Boolean)
        .join('\n  ');
      expect(row.ok, detail).toBe(true);
    });
  }
});

describe('the prose budget', () => {
  it("does not count the copies of the documents in an agent's worktree under .claude/, which made it fail by thousands of lines", () => {
    const prose = (): number | undefined =>
      (JSON.parse(execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8' })) as BudgetRow[]).find(
        (r) => r.name === 'MAX_DOC_LINES',
      )?.value;
    const dir = path.join(path.dirname(script), '..', '.claude', 'worktrees', 'budget-probe');
    const before = prose();
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), 'a line\n'.repeat(500));
      expect(prose()).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

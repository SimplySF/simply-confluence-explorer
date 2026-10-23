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

// Which recorded problems the header counts: those since the person last looked at Observability that
// failed something they asked for. A freeze is recorded there for diagnosis and not counted; the
// person has already waited through it (ADR-073).

import type { ProblemRecord } from '../../../src/telemetry/records.js';

export const headerCount = (problems: Array<Pick<ProblemRecord, 'at' | 'problem'>>, seenAt: string): number =>
  problems.filter((p) => p.at > seenAt && p.problem !== 'frozen').length;

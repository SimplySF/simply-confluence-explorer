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

// A space's own choices, kept beside its rules in spaces/<KEY>/.confluencespace.json, where a sync
// never writes. Today it holds one: whether images on its pages are sent to the AI (ADR-066).

import fs from 'node:fs';
import path from 'node:path';
import type { ImageChoice } from '../api/types.js';
import { sanitizeFilename, within } from '../util/paths.js';

export type SpaceSettings = { images: ImageChoice };

const CHOICES = new Set<string>(['ask', 'send', 'skip']);

function settingsFile(dataDir: string, spaceKey: string): string {
  return within(path.join(dataDir, 'spaces'), sanitizeFilename(spaceKey.toUpperCase()), '.confluencespace.json');
}

/** A space's settings; one never saved, or not readable, asks about images, so none is sent unasked. */
export function loadSpaceSettings(dataDir: string, spaceKey: string): SpaceSettings {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(dataDir, spaceKey), 'utf8')) as { images?: unknown };
    return {
      images: typeof saved.images === 'string' && CHOICES.has(saved.images) ? (saved.images as ImageChoice) : 'ask',
    };
  } catch {
    // No file yet, or one that cannot be read: the safe default, which sends no image.
    return { images: 'ask' };
  }
}

/** Saves a space's settings; anything but a known choice is refused by the caller. */
export function saveSpaceSettings(dataDir: string, spaceKey: string, settings: SpaceSettings): SpaceSettings {
  const file = settingsFile(dataDir, spaceKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

export const isImageChoice = (value: unknown): value is ImageChoice => typeof value === 'string' && CHOICES.has(value);

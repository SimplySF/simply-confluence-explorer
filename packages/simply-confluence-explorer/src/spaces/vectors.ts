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

import type { PageDetail } from '../api/types.js';
import type { SpaceStore } from './spaceStore.js';

// Section embeddings, so a question finds the sections that mean what it asks, not only those that
// share its words (ADR-051). Vectors are saved as base64 Float32 beside the synced copy and loaded
// once into memory, which for a space of thousands of pages is tens of megabytes.

/** A page's section vectors on disk, for one page version and one model. */
export type PageVectors = {
  model: string;
  version: number;
  /** One per section in `splitSections` order; null for a section the guard did not let out. */
  sections: Array<string | null>;
};

export type VectorHit = { pageId: string; index: number; score: number };

export function encodeVector(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

export function decodeVector(text: string): Float32Array {
  const bytes = Buffer.from(text, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** How alike two vectors point, from -1 to 1; 0 when either is empty or their lengths differ. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const keyOf = (page: PageDetail): string => `${page.spaceKey.toUpperCase()}/${page.id}`;

type Loaded = { version: number; model: string; sections: Array<Float32Array | null> | null };

/** Reads, writes and compares a space's section vectors, keeping those it has read in memory. */
export class VectorIndex {
  private readonly loaded = new Map<string, Loaded>();

  public constructor(private readonly store: SpaceStore) {}

  /** Whether a page has vectors for its current version from this model. */
  public has(page: PageDetail, model: string): boolean {
    return !!this.load(page, model);
  }

  public write(page: PageDetail, model: string, vectors: Array<number[] | null>): void {
    this.store.writeVectors(page.spaceKey, page.id, {
      model,
      version: page.version,
      sections: vectors.map((v) => (v ? encodeVector(v) : null)),
    });
    this.loaded.set(keyOf(page), {
      version: page.version,
      model,
      sections: vectors.map((v) => (v ? new Float32Array(v) : null)),
    });
  }

  /**
   * The sections of `pages` most like `query`. Pages without current vectors from this model are
   * skipped, so a space only partly indexed is still searched where it can be.
   */
  public nearest(pages: PageDetail[], query: number[], model: string, limit: number): VectorHit[] {
    const hits: VectorHit[] = [];
    for (const page of pages) {
      (this.load(page, model) ?? []).forEach((vector, index) => {
        if (vector) hits.push({ pageId: page.id, index, score: cosine(query, vector) });
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private load(page: PageDetail, model: string): Array<Float32Array | null> | null {
    const cached = this.loaded.get(keyOf(page));
    if (cached?.version === page.version && cached.model === model) return cached.sections;
    const saved = this.store.readVectors(page.spaceKey, page.id);
    const current = saved?.version === page.version && saved.model === model;
    const sections = current ? saved.sections.map((v) => (v ? decodeVector(v) : null)) : null;
    // A page with no current vectors is remembered as such, so each question does not read its file again.
    this.loaded.set(keyOf(page), { version: page.version, model, sections });
    return sections;
  }
}

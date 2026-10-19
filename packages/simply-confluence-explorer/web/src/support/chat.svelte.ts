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

import type { AiSessionView, SessionScope } from '../../../src/api/types.js';
import { sessions } from './api.js';
import { messageOf } from './toast.svelte.js';

/**
 * The conversation for a page, a branch or a space. The latest one is resumed when the scope is
 * opened, and one is created on the first question or file.
 */
export class AiChat {
  public session = $state<AiSessionView | null>(null);
  public pending = $state<string | null>(null);
  public error = $state<string | null>(null);
  private scope: SessionScope | null = null;
  private generation = 0;
  private stopper: AbortController | null = null;

  public get sending(): boolean {
    return this.pending !== null;
  }

  /** Opens the conversation for a scope, dropping whatever was shown for the previous one at once. */
  public open(scope: SessionScope): void {
    this.scope = scope;
    this.session = null;
    this.error = null;
    const generation = ++this.generation;
    sessions.latest(scope).then(
      (s) => generation === this.generation && (this.session = s),
      (e: unknown) => generation === this.generation && (this.error = messageOf(e)),
    );
  }

  public async send(prompt: string): Promise<void> {
    this.error = null;
    this.pending = prompt;
    const stopper = new AbortController();
    this.stopper = stopper;
    try {
      const s = await this.ensure();
      this.session = await sessions.send(s.id, prompt, stopper.signal);
    } catch (e) {
      // A stopped question is not an error: the person is about to ask it again.
      if (!stopper.signal.aborted) this.error = messageOf(e);
    } finally {
      if (this.stopper === stopper) {
        this.stopper = null;
        this.pending = null;
      }
    }
  }

  /**
   * Stops the question being answered. The server keeps no part of it (ADR-047).
   *
   * @returns The question, so it can be put back in the box to correct and send again.
   */
  public stop(): string | null {
    const prompt = this.pending;
    this.stopper?.abort();
    this.stopper = null;
    this.pending = null;
    return prompt;
  }

  public async addFiles(files: File[]): Promise<void> {
    this.error = null;
    try {
      let s = await this.ensure();
      for (const f of files) s = await sessions.addFile(s.id, f); // eslint-disable-line no-await-in-loop -- one at a time keeps the order
      this.session = s;
    } catch (e) {
      this.error = messageOf(e);
    }
  }

  public async removeFile(fileId: string): Promise<void> {
    if (this.session) this.session = await sessions.removeFile(this.session.id, fileId);
  }

  /** The next question starts a fresh conversation; earlier ones stay on the server. */
  public startNew(): void {
    this.session = null;
    this.error = null;
  }

  /** Starts on a scope with no conversation shown, without resuming the latest one. */
  public begin(scope: SessionScope): void {
    this.generation++;
    this.scope = scope;
    this.session = null;
    this.error = null;
  }

  /** Shows a conversation chosen from a list, such as Space chat's. */
  public show(session: AiSessionView, scope: SessionScope): void {
    this.generation++;
    this.scope = scope;
    this.session = session;
    this.error = null;
  }

  /** The conversation, created now if no question has been asked yet, so it can be named or given pages first. */
  public async ensure(): Promise<AiSessionView> {
    if (!this.session) this.session = await sessions.create(this.scope!);
    return this.session;
  }
}

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

import type { AiSessionView, AttachmentChoice, SessionScope } from '../../../src/api/types.js';
import { sessions, type Focus } from './api.js';
import { jobs } from './jobs.svelte.js';
import { messageOf } from './toast.svelte.js';

/**
 * The conversation for a page, a branch or a space. The latest one is resumed when the scope is
 * opened, and one is created on the first question or file.
 */
export class AiChat {
  public session = $state<AiSessionView | null>(null);
  public pending = $state<string | null>(null);
  public error = $state<string | null>(null);
  // Reactive, so the question box can offer what fits the scope before the first question.
  private scope = $state<SessionScope | null>(null);
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

  /** What the conversation reads, so the question box can offer what fits it. */
  public get scopeKind(): SessionScope['kind'] | undefined {
    return this.session?.scope.kind ?? this.scope?.kind;
  }

  /**
   * Asks a question. A thorough question about more pages than one request carries is answered in
   * the background over several requests, and its answer is read again when it finishes.
   */
  public send(prompt: string, thorough = false, focus?: Focus): Promise<void> {
    return this.ask(prompt, async (id, signal) => {
      const { batch, ...session } = await sessions.send(id, prompt, signal, thorough, focus);
      if (batch) jobs.watchBatch(batch, session.scope.kind === 'branch' ? session.scope.pageId : undefined);
      return session;
    });
  }

  /**
   * Asks for suggestions for the chat's review queue: a review of what the chat reads, or
   * the changes the conversation so far has agreed (ADR-049).
   */
  public suggest(kind: 'review' | 'changes', shown: string): Promise<void> {
    return this.ask(shown, async (id, signal) => {
      const { batch, ...session } = await sessions.suggest(id, kind, signal);
      // Too many pages for one request: the review runs in batches on the server, and its answer is
      // read again when it finishes (ADR-051).
      if (batch) jobs.watchBatch(batch, session.scope.kind === 'branch' ? session.scope.pageId : undefined);
      return session;
    });
  }

  /** Reads the conversation again, as after a batched review writes its answer. */
  public async reload(): Promise<void> {
    if (this.session) this.session = await sessions.get(this.session.id);
  }

  private async ask(shown: string, call: (id: string, signal: AbortSignal) => Promise<AiSessionView>): Promise<void> {
    this.error = null;
    this.pending = shown;
    const stopper = new AbortController();
    this.stopper = stopper;
    try {
      const s = await this.ensure();
      this.session = await call(s.id, stopper.signal);
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

  /** Whether this chat reads its pages' attachments, kept with the chat (ADR-069). */
  public async chooseAttachments(choice: AttachmentChoice): Promise<void> {
    const s = await this.ensure();
    this.session = await sessions.update(s.id, { attachments: choice });
  }
}

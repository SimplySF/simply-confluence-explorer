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

// Reports the outcome of an action without stopping the person, as a browser alert would.

export type ToastKind = 'info' | 'success' | 'error';
/** Something the person can do about the message, such as opening its trace. */
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; message: string; kind: ToastKind; action?: ToastAction };

// An error stays long enough to be read and copied; it can always be dismissed sooner.
const LIFETIME: Record<ToastKind, number> = { info: 5000, success: 5000, error: 12000 };

let nextId = 0;

export const toasts = $state<Toast[]>([]);

export function dismiss(id: number): void {
  const at = toasts.findIndex((t) => t.id === id);
  if (at >= 0) toasts.splice(at, 1);
}

/**
 * Shows a message in the corner of the screen.
 *
 * @param message What happened, in words a person can act on.
 * @param kind Whether it went well.
 * @param action A button that leads to more, such as the trace of what failed.
 */
export function toast(message: string, kind: ToastKind = 'info', action?: ToastAction): void {
  const id = ++nextId;
  toasts.push({ id, message, kind, ...(action ? { action } : {}) });
  if (toasts.length > 4) toasts.shift();
  setTimeout(() => dismiss(id), LIFETIME[kind]);
}

/** The message of anything thrown, for a toast or an inline error. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

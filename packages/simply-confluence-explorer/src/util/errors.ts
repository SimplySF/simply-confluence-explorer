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

/**
 * Returns an error's message in a form that is safe to log or send to a browser. Only the message
 * is taken, never the rest of the error object, which for a failed HTTP request can include the
 * request's headers and so the token.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

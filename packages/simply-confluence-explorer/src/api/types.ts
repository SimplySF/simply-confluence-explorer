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

// The shapes of the JSON the server's /api routes send and accept. The frontend in web/ imports
// this module with `import type` only, so these declarations are the one place both halves agree on
// and no server code can reach the browser bundle.

/** The body of every error response. */
export type ErrorResponse = {
  error: string;
};

/** Where the Confluence connection comes from: the server's environment, Settings, or nowhere yet. */
export type ConnectionSource = 'env' | 'settings' | 'none';

/** What a browser may know about the Confluence connection. The token itself is never included. */
export type ConnectionView = {
  baseUrl: string;
  tokenSet: boolean;
  source: ConnectionSource;
  /** False when the environment sets the connection, because Settings cannot change it then. */
  editable: boolean;
  /** The runtime profile, such as `dev` when the app runs against the test environment. */
  profile: string;
};

/** A change to the connection, sent from Settings. */
export type ConnectionUpdate = {
  baseUrl?: string;
  /** Leaving this out keeps the saved token; an empty string removes it. */
  token?: string;
};

/** The outcome of one doctor check. */
export type DoctorLevel = 'ok' | 'warn' | 'fail' | 'skip';

export type DoctorResult = {
  id: string;
  level: DoctorLevel;
  summary: string;
  /** What to do about a warning or failure. Present on every `warn` and `fail`. */
  fix?: string;
};

/** The doctor's full report. `ok` is false when any check failed; warnings do not make it false. */
export type DoctorReport = {
  results: DoctorResult[];
  ok: boolean;
};

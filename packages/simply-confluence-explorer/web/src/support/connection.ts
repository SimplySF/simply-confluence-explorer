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

// Whether the app is signed in to Confluence, and the spaces it can see. Signing in and listing the
// spaces are separate questions with separate answers, so a space list that fails to load is reported
// as itself rather than as the app being disconnected.

import type { AuthVerifyResponse, ConfluenceSpace, ConnectionView } from '../../../src/api/types.js';

export type ConnectionState = {
  connection: ConnectionView;
  connected: boolean;
  /** The signed-in user's name, when signed in. */
  user?: string;
  /** Why signing in failed. */
  reason?: string;
  spaces: ConfluenceSpace[];
  /** Why the spaces did not load, when signing in worked but listing them did not. */
  spacesError?: string;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function checkConnection(api: {
  connection: () => Promise<ConnectionView>;
  verify: () => Promise<AuthVerifyResponse>;
  spaces: () => Promise<ConfluenceSpace[]>;
}): Promise<ConnectionState> {
  const connection = await api.connection();
  if (!connection.baseUrl) return { connection, connected: false, spaces: [] };
  let verified: AuthVerifyResponse;
  try {
    verified = await api.verify();
  } catch (e) {
    return { connection, connected: false, reason: messageOf(e), spaces: [] };
  }
  if (!verified.success) return { connection, connected: false, reason: verified.error, spaces: [] };
  const user = verified.user?.displayName ?? 'User';
  try {
    return { connection, connected: true, user, spaces: await api.spaces() };
  } catch (e) {
    return { connection, connected: true, user, spaces: [], spacesError: messageOf(e) };
  }
}

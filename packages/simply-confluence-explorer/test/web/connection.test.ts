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

import { describe, expect, it } from 'vitest';
import type { ConnectionView } from '../../src/api/types.js';
import { checkConnection } from '../../web/src/support/connection.js';

const view: ConnectionView = {
  baseUrl: 'https://wiki.example.com',
  tokenSet: true,
  source: 'settings',
  editable: true,
  profile: '',
};
const space = { key: 'OPS', name: 'Operations', type: 'global' };

describe('the connection status', () => {
  it('stays connected when signing in works but the spaces fail to load, which showed as Not connected', async () => {
    const state = await checkConnection({
      connection: () => Promise.resolve(view),
      verify: () =>
        Promise.resolve({ success: true, baseUrl: view.baseUrl, user: { displayName: 'Test Admin' } as never }),
      spaces: () => Promise.reject(new Error('The server answered 500.')),
    });
    expect(state).toMatchObject({
      connected: true,
      user: 'Test Admin',
      spaces: [],
      spacesError: 'The server answered 500.',
    });
  });

  it('is not connected, with the reason, when signing in fails or cannot be asked', async () => {
    const refused = await checkConnection({
      connection: () => Promise.resolve(view),
      verify: () => Promise.resolve({ success: false, baseUrl: view.baseUrl, error: 'The token was refused.' }),
      spaces: () => Promise.resolve([space]),
    });
    expect(refused).toMatchObject({ connected: false, reason: 'The token was refused.', spaces: [] });
    const unreachable = await checkConnection({
      connection: () => Promise.resolve(view),
      verify: () => Promise.reject(new Error('Failed to fetch')),
      spaces: () => Promise.resolve([space]),
    });
    expect(unreachable).toMatchObject({ connected: false, reason: 'Failed to fetch' });
  });

  it('lists the spaces when signed in, and asks nothing when no Confluence is set up', async () => {
    const api = {
      connection: () => Promise.resolve(view),
      verify: () => Promise.resolve({ success: true, baseUrl: view.baseUrl }),
      spaces: () => Promise.resolve([space]),
    };
    expect(await checkConnection(api)).toMatchObject({ connected: true, user: 'User', spaces: [space] });
    const none = await checkConnection({ ...api, connection: () => Promise.resolve({ ...view, baseUrl: '' }) });
    expect(none).toMatchObject({ connected: false, spaces: [] });
  });
});

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

// A stand-in for GitLab's REST API, enough to read one repository: the user behind a token, a project,
// its file tree in pages of 100, and each file's raw text. It records every request it is sent.

/* eslint-disable camelcase -- the field names are GitLab's own */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const GITLAB_TOKEN = 'fake-gitlab-token';
export const GITLAB_PROJECT = 'platform/billing-service';

export type FakeGitLab = {
  url: string;
  /** The repository's files, by path; tests may add to it. */
  files: Map<string, string>;
  requests: Array<{ path: string; token: string }>;
  close: () => Promise<void>;
};

export async function startFakeGitLab(): Promise<FakeGitLab> {
  const files = new Map<string, string>([
    ['README.md', '# Billing service\n\nCharges customers each month.'],
    ['docs/architecture.md', 'The service reads usage from Kafka.'],
    ['api/openapi.yaml', 'openapi: 3.0.0\npaths:\n  /invoices: {}'],
    ['package.json', '{"name":"billing-service"}'],
    ['src/index.ts', 'export const secretSauce = 1;'],
  ]);
  const requests: FakeGitLab['requests'] = [];
  const project = encodeURIComponent(GITLAB_PROJECT);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = String(req.headers['private-token'] ?? '');
    requests.push({ path: url.pathname, token });
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (token !== GITLAB_TOKEN) return json(401, { message: '401 Unauthorized' });
    const raw = url.pathname.replace(/^\/api\/v4/, '');
    if (raw === '/user') return json(200, { username: 'tech.lead', name: 'Tech Lead' });
    if (raw === `/projects/${project}`)
      return json(200, { name: 'billing-service', web_url: 'https://gitlab.example.test/x', default_branch: 'main' });
    if (raw === `/projects/${project}/repository/tree`) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const all = [...files.keys()].map((p) => ({ path: p, type: 'blob' }));
      return json(200, all.slice((page - 1) * 100, page * 100));
    }
    const file = new RegExp(`^/projects/${project.replace(/%/g, '%')}/repository/files/(.+)/raw$`).exec(raw);
    if (file) {
      const body = files.get(decodeURIComponent(file[1]));
      if (body === undefined) return json(404, { message: '404 File Not Found' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
      return;
    }
    json(404, { message: '404 Project Not Found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    files,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

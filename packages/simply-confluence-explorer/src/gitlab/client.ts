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

import path from 'node:path';
import type { GitLabView } from '../api/types.js';
import { HttpError } from '../http/router.js';
import { readJsonOrEmpty, writePrivateJson } from '../util/privateFile.js';

// The app's only connection to GitLab (ADR-050). The server holds the address and the token, the
// token is never sent back to a browser, and a repository is read only from the configured GitLab,
// so a request cannot make the server fetch from a host of its choosing. What is read is not
// Confluence content: it is checked by the outbound guard like an uploaded file.

type Stored = { baseUrl?: string; token?: string };

/** The most files, and characters, one repository may add to a draft. */
export const REPO_FILE_LIMIT = 40;
export const REPO_CHAR_LIMIT = 200_000;
const FILE_CHAR_LIMIT = 50_000;
const TREE_PAGES = 10;

const normalize = (url: string): string => url.trim().replace(/\/+$/, '');

export class GitLabStore {
  private readonly file: string;

  public constructor(dataDir: string) {
    this.file = path.join(dataDir, 'config', 'gitlab.json');
  }

  public resolve(): { baseUrl: string; token: string } {
    const saved = readJsonOrEmpty<Stored>(this.file);
    return { baseUrl: normalize(saved.baseUrl ?? ''), token: saved.token ?? '' };
  }

  /** What a browser may see: whether a token is set, but never the token. */
  public publicView(): GitLabView {
    const { baseUrl, token } = this.resolve();
    return { baseUrl, tokenSet: token !== '' };
  }

  /** A connection to test before it is saved. The saved token is reused only for the address it was saved with. */
  public candidate(change: Stored): { baseUrl: string; token: string } {
    const current = this.resolve();
    const baseUrl = normalize(change.baseUrl ?? current.baseUrl);
    if (change.token) return { baseUrl, token: change.token.trim() };
    return { baseUrl, token: baseUrl === current.baseUrl ? current.token : '' };
  }

  public update(change: Stored): void {
    const typed = change.baseUrl?.trim();
    if (typed && !/^https?:\/\/[^\s/]+/.test(typed))
      throw new HttpError(400, 'The GitLab address must start with http:// or https://');
    const next = readJsonOrEmpty<Stored>(this.file);
    const urlChanged = change.baseUrl !== undefined && normalize(change.baseUrl) !== normalize(next.baseUrl ?? '');
    if (change.baseUrl !== undefined) next.baseUrl = normalize(change.baseUrl) || undefined;
    // A token belongs to the address it was issued for, so a new address without a new token drops it.
    if (change.token !== undefined) next.token = change.token.trim() || undefined;
    else if (urlChanged) next.token = undefined;
    writePrivateJson(this.file, next);
  }
}

/**
 * The project path and branch in a link to a repository on the configured GitLab, such as
 * `https://gitlab.example.com/group/team/service` or `.../service/-/tree/main`. A link on any other
 * host is refused.
 *
 * @param link The link the person pasted.
 * @param baseUrl The configured GitLab address.
 */
export function parseRepoLink(link: string, baseUrl: string): { project: string; ref?: string } {
  let url: URL;
  let base: URL;
  try {
    url = new URL(link.trim());
    base = new URL(baseUrl);
  } catch {
    throw new HttpError(400, 'That is not a link to a GitLab repository.');
  }
  if (url.origin !== base.origin)
    throw new HttpError(400, `Only repositories on the configured GitLab (${base.host}) can be read.`);
  const below = url.pathname.slice(base.pathname.replace(/\/$/, '').length).replace(/^\/+|\/+$/g, '');
  const [projectPart, rest] = below.split('/-/');
  const project = projectPart.replace(/\.git$/, '');
  if (!project.includes('/') || project.split('/').some((s) => !/^[\w.-]+$/.test(s)))
    throw new HttpError(400, 'That is not a link to a GitLab repository.');
  const ref = /^(?:tree|blob)\/([^/]+)/.exec(rest ?? '')?.[1];
  return { project, ...(ref ? { ref: decodeURIComponent(ref) } : {}) };
}

/** Whether a repository file says what the code is: its README, its docs, its API descriptions, or its manifest. */
const worthReading = (file: string): boolean =>
  /^readme(\.\w+)?$/i.test(file) ||
  /^docs\/.+\.(md|mdx|markdown)$/i.test(file) ||
  /(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$/i.test(file) ||
  /^(package\.json|pom\.xml|go\.mod|pyproject\.toml|cargo\.toml|build\.gradle(\.kts)?|composer\.json|gemfile)$/i.test(
    file,
  );

export type RepoDigest = { name: string; webUrl: string; files: string[]; text: string };

export class GitLabClient {
  public constructor(
    private readonly connection: { baseUrl: string; token: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Checks the address and token, and says whose token it is. */
  public async test(): Promise<{ username: string; name: string }> {
    return this.get<{ username: string; name: string }>('/user');
  }

  /**
   * Reads what a repository says about itself, within fixed limits: its file list, README, Markdown
   * docs, API description files and manifest.
   *
   * @param link A link to the repository on the configured GitLab.
   */
  public async readRepository(link: string): Promise<RepoDigest> {
    const { project, ref: linkRef } = parseRepoLink(link, this.connection.baseUrl);
    const id = encodeURIComponent(project);
    const info = await this.get<{ name: string; web_url: string; description?: string; default_branch?: string }>(
      `/projects/${id}`,
    );
    const ref = linkRef ?? info.default_branch ?? 'main';
    const paths: string[] = [];
    for (let page = 1; page <= TREE_PAGES; page++) {
      // eslint-disable-next-line no-await-in-loop -- pages of the file list follow one another
      const batch = await this.get<Array<{ path: string; type: string }>>(
        `/projects/${id}/repository/tree?${new URLSearchParams({ ref, recursive: 'true', ['per_page']: '100', page: String(page) }).toString()}`,
      );
      paths.push(...batch.filter((e) => e.type === 'blob').map((e) => e.path));
      if (batch.length < 100) break;
    }
    const chosen = paths.filter(worthReading).slice(0, REPO_FILE_LIMIT);
    let used = 0;
    const parts: string[] = [];
    for (const file of chosen) {
      if (used >= REPO_CHAR_LIMIT) break;
      // eslint-disable-next-line no-await-in-loop -- one file at a time keeps within the character limit
      const body = await this.raw(
        `/projects/${id}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`,
      );
      const text = body.slice(0, Math.min(FILE_CHAR_LIMIT, REPO_CHAR_LIMIT - used));
      used += text.length;
      parts.push(`## ${file}\n\n\`\`\`\n${text}\n\`\`\``);
    }
    const listing = paths.slice(0, 300).join('\n');
    return {
      name: info.name,
      webUrl: info.web_url,
      files: chosen,
      text:
        `# Repository: ${info.name} (${info.web_url}, ${ref})\n${info.description ?? ''}\n\n` +
        `## Files in the repository${paths.length > 300 ? ' (the first 300)' : ''}\n\n${listing}\n\n${parts.join('\n\n')}`,
    };
  }

  private async request(route: string): Promise<Response> {
    if (!this.connection.baseUrl || !this.connection.token)
      throw new HttpError(400, 'GitLab is not set up: add its address and a token under Settings → GitLab.');
    const res = await this.fetchImpl(`${this.connection.baseUrl}/api/v4${route}`, {
      headers: { 'PRIVATE-TOKEN': this.connection.token },
    });
    if (res.status === 401) throw new HttpError(400, 'GitLab refused the token. Check it under Settings → GitLab.');
    if (res.status === 403 || res.status === 404)
      throw new HttpError(404, 'GitLab did not find that repository, or the token cannot read it.');
    if (!res.ok) throw new HttpError(502, `GitLab answered ${res.status}.`);
    return res;
  }

  private async get<T>(route: string): Promise<T> {
    return (await (await this.request(route)).json()) as T;
  }

  private async raw(route: string): Promise<string> {
    return (await this.request(route)).text();
  }
}

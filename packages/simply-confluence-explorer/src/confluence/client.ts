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

import {
  AuthError,
  buildAuthHeaders,
  ConfigError,
  ConfluenceClient as LibraryClient,
  HttpError as LibraryHttpError,
  HttpTransport,
  preparePageUpdate,
  resolveConfluenceConfig,
  updatePage,
  type PageUpdatePlan,
} from '@simplysf/simply-atlassian-core';
import type {
  AuthVerifyResponse,
  ConfluenceAttachment,
  ConfluenceSpace,
  PageDetail,
  PageTreeNode,
} from '../api/types.js';
import { HttpError } from '../http/router.js';
import { errorMessage } from '../util/errors.js';
import { runLimited } from '../util/runLimited.js';
import type { RestAttachment, RestContent, RestLicense, RestList, RestSpace, RestUser } from './rest.js';

// This is the only module that talks to Confluence (ADR-028). It reads through
// simply-atlassian-core, which verifies certificates and retries rate limits and server errors, and
// it turns the library's errors into the statuses this app answers with.

const PAGE_EXPAND = ['body.storage', 'version', 'ancestors', 'metadata.labels', 'children.attachment', 'space'];
const CHILD_EXPAND = ['version', 'history.lastUpdated'];
const PAGE_SIZE = 50;
/** How many requests a tree read keeps in flight at once. */
const TREE_CONCURRENCY = 4;
/** Deeper than any real space; it stops a page that is somehow its own descendant. */
const MAX_TREE_DEPTH = 25;
const SPACES_TTL_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const spacesCache = new Map<string, { at: number; spaces: ConfluenceSpace[] }>();

type Linked = { _links?: { webui?: string; download?: string; next?: string } };
// eslint-disable-next-line no-underscore-dangle -- Atlassian's field name
const linksOf = (item: Linked): NonNullable<Linked['_links']> => item._links ?? {};

export type ConnectionDetails = { baseUrl: string; token: string };

export class ConfluenceClient {
  public readonly baseUrl: string;
  private readonly cacheKey: string;
  private readonly library?: LibraryClient;
  private readonly transport?: HttpTransport;
  private readonly headers: Record<string, string> = {};
  private readonly configError?: string;

  public constructor(connection: ConnectionDetails) {
    this.baseUrl = connection.baseUrl;
    this.cacheKey = `${connection.baseUrl}\n${connection.token}`;
    try {
      // An empty environment, so only the connection given here is used and never the process's.
      const config = resolveConfluenceConfig({ url: connection.baseUrl, personalToken: connection.token }, {});
      this.library = new LibraryClient(config);
      this.headers = buildAuthHeaders(config);
      this.transport = new HttpTransport({ baseUrl: config.url, headers: this.headers });
    } catch (error) {
      // Reported on first use, so a missing connection is a clear 400 rather than a crash at startup.
      this.configError = errorMessage(error);
    }
  }

  /** Tests the connection by asking who the token belongs to. Never throws. */
  public async verify(): Promise<AuthVerifyResponse> {
    try {
      const user = await this.get<RestUser>('/rest/api/user/current');
      return {
        success: true,
        baseUrl: this.baseUrl,
        user: { username: user.username, displayName: user.displayName, email: user.email, userKey: user.userKey },
      };
    } catch (error) {
      return { success: false, baseUrl: this.baseUrl, error: errorMessage(error) };
    }
  }

  public async getSpace(spaceKey: string): Promise<ConfluenceSpace> {
    return this.toSpace(
      await this.get<RestSpace>(`/rest/api/space/${encodeURIComponent(spaceKey)}`, {
        expand: 'description.plain,homepage',
      }),
    );
  }

  /**
   * Lists every global space, cached for a few minutes because large instances have hundreds. A
   * query filters by key or name, and when nothing in the list matches it is tried as an exact key,
   * which finds personal and archived spaces the list leaves out.
   */
  public async getSpaces(query?: string): Promise<ConfluenceSpace[]> {
    const cached = spacesCache.get(this.cacheKey);
    let spaces = cached && Date.now() - cached.at < SPACES_TTL_MS ? cached.spaces : undefined;
    if (!spaces) {
      const results = await this.collect<RestSpace>('/rest/api/space', {
        type: 'global',
        expand: 'description.plain,homepage',
      });
      spaces = results.map((s) => this.toSpace(s));
      spacesCache.set(this.cacheKey, { at: Date.now(), spaces });
    }
    const q = query?.trim().toLowerCase();
    if (!q) return spaces;
    const matches = spaces.filter((s) => s.key.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
    if (matches.length > 0) return matches;
    try {
      return [await this.getSpace(query!.trim())];
    } catch {
      // No space has that key either; an empty list is the answer.
      return [];
    }
  }

  public async getPageDetail(pageId: string): Promise<PageDetail> {
    const content = (await call(() => this.lib().getPage(pageId, { expand: PAGE_EXPAND }))) as RestContent;
    if (typeof content !== 'object' || !content.id)
      throw new HttpError(404, `Page ${pageId} was not found in Confluence`);
    return this.toDetail(content);
  }

  /**
   * Reads a space's page tree: everything under its homepage, or everything under `rootPageId`
   * when one is given. A space without a homepage is read as a flat list and assembled from each
   * page's ancestors.
   */
  public async getPageTree(spaceKey: string, rootPageId?: string): Promise<PageTreeNode[]> {
    const rootId = rootPageId ?? (await this.getSpace(spaceKey)).homepageId;
    if (rootId) {
      const root = await this.getPageDetail(rootId);
      const node: PageTreeNode = { ...summaryOf(root), children: [] };
      await this.loadChildren(node, 0);
      return [node];
    }
    const pages = await this.collect<RestContent>('/rest/api/content', {
      spaceKey,
      type: 'page',
      expand: 'ancestors,version',
    });
    return assembleTree(pages.map((p) => this.toNode(p, spaceKey, p.ancestors?.at(-1)?.id)));
  }

  /**
   * Downloads an attachment. The address must be on the configured Confluence, so the token is
   * never sent anywhere else (ADR-019), even if a page's data named another server.
   */
  public async downloadAttachment(url: string): Promise<Buffer> {
    if (!this.transport) throw new HttpError(400, this.notConfigured());
    if (!url.startsWith(`${this.baseUrl}/`))
      throw new HttpError(400, `refusing to download from outside ${this.baseUrl}`);
    const res = await call(() =>
      fetch(url, { headers: this.headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }),
    );
    if (!res.ok) throw new HttpError(502, `downloading ${url} failed with status ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Reads a page's current version and converts the new body to storage format, without writing
   * anything. Content Confluence would not accept, such as raw HTML or an unclosed code fence, is
   * refused here with a 400 that names the line, which is what a dry run reports.
   */
  public prepareUpdate(
    pageId: string,
    change: { markdown: string; title?: string; append?: boolean },
  ): Promise<PageUpdatePlan> {
    return call(() => preparePageUpdate(this.lib(), pageId, change));
  }

  /**
   * Writes a prepared update. The write names the version that was read, so Confluence itself
   * refuses it with a 409 if the page has changed in the meantime.
   */
  public applyUpdate(plan: PageUpdatePlan): Promise<unknown> {
    return call(() => updatePage(this.lib(), plan));
  }

  /** The Data Center license, which only administrators may read; `null` for anyone else. */
  public async getLicenseDetails(): Promise<RestLicense | null> {
    try {
      return await this.get<RestLicense>('/rest/license/1.0/license/details');
    } catch {
      // Not an administrator, or not Data Center: the doctor reports the license as unreadable.
      return null;
    }
  }

  private async loadChildren(parent: PageTreeNode, depth: number): Promise<void> {
    if (depth >= MAX_TREE_DEPTH) return;
    const children = await this.collect<RestContent>(`/rest/api/content/${encodeURIComponent(parent.id)}/child/page`, {
      expand: CHILD_EXPAND.join(','),
    });
    parent.children = children.map((c) => this.toNode(c, parent.spaceKey, parent.id));
    await runLimited(
      parent.children.map((child) => (): Promise<void> => this.loadChildren(child, depth + 1)),
      TREE_CONCURRENCY,
    );
  }

  /** Follows a list endpoint's pages until Confluence stops offering a next one. */
  private async collect<T>(path: string, query: Record<string, string>, start = 0): Promise<T[]> {
    const page = await this.get<RestList<T>>(path, { ...query, start: String(start), limit: String(PAGE_SIZE) });
    const results = page.results ?? [];
    if (results.length === 0 || linksOf(page).next === undefined) return results;
    return [...results, ...(await this.collect<T>(path, query, start + results.length))];
  }

  private get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return call(() => this.http().json<T>({ method: 'GET', path, query }));
  }

  private lib(): LibraryClient {
    if (!this.library) throw new HttpError(400, this.notConfigured());
    return this.library;
  }

  private http(): HttpTransport {
    if (!this.transport) throw new HttpError(400, this.notConfigured());
    return this.transport;
  }

  private notConfigured(): string {
    return `Confluence is not configured: save the connection in Settings, or set CONFLUENCE_URL and CONFLUENCE_PERSONAL_TOKEN (${this.configError ?? 'no URL'})`;
  }

  private link(path: string | undefined): string | undefined {
    return path ? `${this.baseUrl}${path}` : undefined;
  }

  private toSpace(s: RestSpace): ConfluenceSpace {
    return {
      key: s.key,
      name: s.name,
      type: s.type,
      description: s.description?.plain?.value,
      homepageId: s.homepage?.id,
      url: this.link(linksOf(s).webui),
    };
  }

  private toNode(c: RestContent, spaceKey: string, parentId: string | undefined): PageTreeNode {
    return {
      id: c.id,
      title: c.title,
      spaceKey,
      parentId,
      version: c.version?.number ?? 1,
      author: c.version?.by?.displayName ?? c.history?.lastUpdated?.by?.displayName ?? 'Unknown',
      lastModified: c.version?.when ?? c.history?.lastUpdated?.when ?? '',
      webUrl: this.link(linksOf(c).webui),
      children: [],
    };
  }

  private toDetail(content: RestContent): PageDetail {
    const ancestors = content.ancestors ?? [];
    return {
      id: content.id,
      title: content.title,
      spaceKey: content.space?.key ?? '',
      parentId: ancestors.at(-1)?.id,
      version: content.version?.number ?? 1,
      author: content.version?.by?.displayName ?? 'Unknown',
      lastModified: content.version?.when ?? '',
      webUrl: this.link(linksOf(content).webui),
      storageXml: content.body?.storage?.value ?? '',
      labels: labelsOf(content),
      attachments: (content.children?.attachment?.results ?? []).map((a) => this.toAttachment(a)),
      ancestors: ancestors.map((a) => ({ id: a.id, title: a.title })),
    };
  }

  private toAttachment(a: RestAttachment): ConfluenceAttachment {
    return {
      id: a.id,
      title: a.title,
      mediaType: a.metadata?.mediaType ?? a.extensions?.mediaType ?? 'application/octet-stream',
      fileSize: a.extensions?.fileSize ?? 0,
      downloadUrl: this.link(linksOf(a).download) ?? '',
    };
  }
}

const labelsOf = (content: RestContent): string[] => content.metadata?.labels?.results.map((l) => l.name) ?? [];

/** Runs a library call and answers its failures with this app's statuses. */
async function call<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof ConfigError) throw new HttpError(400, error.message);
    if (error instanceof LibraryHttpError && error.status === 404) throw new HttpError(404, error.message);
    // The library reports a version conflict on a write as a plain error naming it.
    if (error instanceof Error && /changed by someone else/i.test(error.message))
      throw new HttpError(409, error.message);
    // The token was refused, or Confluence failed or could not be reached. That is a bad gateway: it
    // is not this server's fault, and not a 401 for the browser either, which holds no credentials.
    if (error instanceof AuthError) throw new HttpError(502, `Confluence refused the token: ${error.message}`);
    throw new HttpError(502, errorMessage(error));
  }
}

function summaryOf(page: PageDetail): Omit<PageTreeNode, 'children'> {
  const { id, title, spaceKey, parentId, version, author, lastModified, webUrl } = page;
  return { id, title, spaceKey, parentId, version, author, lastModified, webUrl };
}

/** Nests a flat list of pages under their parents; a page whose parent is not in the list is a root. */
export function assembleTree(nodes: PageTreeNode[]): PageTreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots: PageTreeNode[] = [];
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

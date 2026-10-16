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

/** The person a personal access token belongs to. */
export type AuthUser = {
  username: string;
  displayName: string;
  email?: string;
  userKey?: string;
};

/** The result of testing a connection, from `POST /api/auth/verify`. */
export type AuthVerifyResponse = {
  success: boolean;
  baseUrl: string;
  user?: AuthUser;
  error?: string;
  latencyMs?: number;
};

export type ConfluenceSpace = {
  key: string;
  name: string;
  type: string;
  description?: string;
  homepageId?: string;
  url?: string;
};

export type ConfluenceAttachment = {
  id: string;
  title: string;
  mediaType: string;
  fileSize: number;
  downloadUrl: string;
};

export type PageSummary = {
  id: string;
  title: string;
  spaceKey: string;
  parentId?: string;
  version: number;
  author: string;
  lastModified: string;
  webUrl?: string;
};

/** A page and the pages under it, as the sidebar tree shows them. */
export type PageTreeNode = PageSummary & {
  children: PageTreeNode[];
};

/** Everything the app reads about one page. `storageXml` is the page in Confluence's own format. */
export type PageDetail = PageSummary & {
  storageXml: string;
  labels: string[];
  attachments: ConfluenceAttachment[];
  ancestors: Array<{ id: string; title: string }>;
};

/** A page converted to Markdown, with the frontmatter block the app writes at the top of it. */
export type ParsedPage = {
  pageId: string;
  title: string;
  spaceKey: string;
  frontmatter: Record<string, unknown>;
  /** The frontmatter followed by the page body in Markdown. */
  markdown: string;
};

export type SpacesResponse = { spaces: ConfluenceSpace[] };
export type PageTreeResponse = { tree: PageTreeNode[] };
export type PageResponse = { detail: PageDetail; parsed: ParsedPage };

/** What `POST /api/spaces/resolve-url` found in a pasted URL or page id. */
export type ResolveResponse = { spaceKey?: string; pageId?: string };

/** A space's `.confluenceignore` rules, one pattern per entry. */
export type IgnoreRules = { patterns: string[] };

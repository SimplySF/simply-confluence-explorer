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
/** `isLocal` says whether the answer came from the synced copy on disk rather than from Confluence. */
export type PageTreeResponse = { tree: PageTreeNode[]; isLocal: boolean };
export type PageResponse = { detail: PageDetail; parsed: ParsedPage; isLocal: boolean };

/** What `POST /api/spaces/resolve-url` found in a pasted URL or page id. */
export type ResolveResponse = { spaceKey?: string; pageId?: string };

/** A space's `.confluenceignore` rules, one pattern per entry. */
export type IgnoreRules = { patterns: string[] };

/** A space that has been synced to disk, as `GET /api/space-cache/cached` lists it. */
export type SyncedSpace = {
  spaceKey: string;
  name: string;
  rootPageId?: string;
  rootPageTitle?: string;
  lastSynced: string;
  pageCount: number;
  metadataCount: number;
  hasTOC: boolean;
};

/** A sync's progress, polled while it runs. */
export type SyncProgress = {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  spaceKey: string;
  total: number;
  processed: number;
  /** Pages already on disk at the version Confluence has, and pages left out by the exclusion rules. */
  skippedCount: number;
  downloadedCount: number;
  errorCount: number;
  errors: Array<{ pageId: string; title: string; error: string }>;
  currentPageTitle?: string;
  completedAt?: string;
};

/** One entry in a space's table of contents. */
export type SpaceTocNode = {
  id: string;
  title: string;
  /** Where the page's Markdown is, relative to the space's `pages/` directory. */
  path: string;
  summary?: string;
  tags?: string[];
  documentType?: string;
  children: SpaceTocNode[];
};

export type PurgeResult = { purgedCount: number; remainingPages: number };

/** The AI providers a person can choose in Settings (ADR-017). */
export type AiProvider = 'gemini-cli' | 'anthropic' | 'openai' | 'gemini';

/** What a browser may know about the AI settings. Keys are never included, only whether one is set. */
export type AiSettingsView = {
  provider: AiProvider;
  providers: Record<
    Exclude<AiProvider, 'gemini-cli'>,
    { model: string; baseUrl: string; keySet: boolean; keySource: 'settings' | 'env' | 'none' }
  >;
  geminiCli: { path: string };
  defaults: Record<Exclude<AiProvider, 'gemini-cli'>, string>;
  /** Where the Gemini CLI was found, or `null` when it was not. */
  geminiCliFound: string | null;
};

/** What the outbound guard did to a request: what it blocked and how much personal data it replaced. */
export type GuardReport = {
  blocked: Array<{ kind: 'secret' | 'pii'; type: string; part: string; line: number }>;
  redacted: Record<string, number>;
  /** One sentence for the browser: what was removed, or that nothing was. */
  summary: string;
};

/** The answer to a one-off question about a page or a space. */
export type AnalyzeResponse = {
  answer: string;
  guard: GuardReport;
  engine: string;
  selectedPages?: Array<{ id: string; title: string; score: number }>;
};

/** An AI summary of one page, kept in the space's `metadata/` directory. */
export type PageMetadata = {
  pageId: string;
  title: string;
  summary: string;
  tags: string[];
  documentType: string;
  systemsMentioned: string[];
  generatedAt: string;
};

/** The progress of generating AI summaries for a space, polled while it runs. */
export type MetadataProgress = {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  spaceKey: string;
  total: number;
  processed: number;
  errorCount: number;
  currentPageTitle?: string;
  completedAt?: string;
};

/** What a conversation is about: one page, a page and everything below it, or a whole space. */
export type SessionScope = {
  kind: 'page' | 'branch' | 'space';
  spaceKey: string;
  pageId?: string;
  title?: string;
};

export type SessionTurn = {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** On an answer: what the outbound guard removed, and which pages were left out of the context. */
  guardSummary?: string;
  engine?: string;
  matchedPages?: Array<{ id: string; title: string; score: number }>;
};

export type SessionFileInfo = {
  id: string;
  name: string;
  chars: number;
  /** True when the file's text was longer than one file may contribute, and was cut. */
  truncated: boolean;
  addedAt: string;
};

/** A conversation as a browser sees it. Its guard placeholders stay on the server. */
export type AiSessionView = {
  id: string;
  scope: SessionScope;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
  files: SessionFileInfo[];
};

/** A proposed improvement to a page, and the version of the page it was made from. */
export type RecommendationResponse = {
  critique: string[];
  changelog: string[];
  improvedMarkdown: string;
  guard: GuardReport;
  /** The version the proposal was made from. A push must name it, and is refused if the page moved on. */
  baseVersion: number;
};

/** What a push or a dry run did. */
export type WriteResult = {
  pageId: string;
  /** After a write, the page's new version; after a dry run, the version it would have replaced. */
  version: number;
  dryRun: boolean;
};

export type BranchItemStatus =
  | 'pending'
  | 'working'
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'skipped'
  | 'failed'
  | 'checked'
  | 'check-failed'
  | 'pushed'
  | 'push-failed';

/** One page in a branch improvement run: its proposal, and the person's decision on it. */
export type BranchItem = {
  pageId: string;
  title: string;
  /** The page version the proposal was made from; a push is refused if the page has moved on. */
  baseVersion: number;
  status: BranchItemStatus;
  original?: string;
  proposed?: string;
  critique?: string[];
  changelog?: string[];
  /** Why a page was skipped or a step failed, in words a person can act on. */
  message?: string;
  guardSummary?: string;
  pushedVersion?: number;
};

/** Something a review of a branch found that a maintainer should fix. */
export type BranchFinding = {
  kind: 'incorrect' | 'redundant' | 'stale' | 'structure' | 'gap';
  pages: string[];
  detail: string;
  suggestion?: string;
};

/** A review, or a set of improvement proposals, for a page and everything under it (ADR-024). */
export type BranchRun = {
  id: string;
  kind: 'review' | 'improve';
  spaceKey: string;
  rootPageId: string;
  rootTitle: string;
  focus?: string;
  instructions?: string;
  status: 'running' | 'ready' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  processed: number;
  total: number;
  items: BranchItem[];
  findings?: BranchFinding[];
  /** The review's answer, when it could not be read as findings. */
  reportText?: string;
  /** The pages a review read, by title: findings name pages by title, and this opens them. */
  pageIds?: Record<string, string>;
  /** Pages left out of the run, and why (a secret, the size limit). Excluded pages are never named. */
  leftOut: string[];
  error?: string;
};

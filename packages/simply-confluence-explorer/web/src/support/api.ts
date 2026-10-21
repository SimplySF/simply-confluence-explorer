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

// Every request the browser makes. The server holds the Confluence connection and the AI keys, so
// nothing here ever names a Confluence or carries a token (ADR-019).

import type {
  BatchProgress,
  AiSessionView,
  AiSettingsView,
  AnalyzeResponse,
  AuthVerifyResponse,
  BranchRun,
  ChatQueue,
  ConfluenceSpace,
  ConnectionUpdate,
  ConnectionView,
  GitLabView,
  ImageChoice,
  IgnoreRules,
  MetadataProgress,
  PageMetadata,
  PageResponse,
  PageTreeResponse,
  PurgeResult,
  RedundancyDecision,
  ResolveResponse,
  SessionScope,
  SpaceTocNode,
  StagedPage,
  SyncedSpace,
  SyncProgress,
  TagsResponse,
} from '../../../src/api/types.js';
import type { LogPage, ObservedEvent } from '../../../src/telemetry/query.js';
import type { LiveJob, MetricRecord, ProblemRecord, SpanRecord } from '../../../src/telemetry/records.js';

const key = encodeURIComponent;

/** How long a read waits for the server before saying it did not answer, rather than spinning forever. */
export const READ_TIMEOUT_MS = 30_000;

/** A request the server did not answer in time; it is usually busy, which the Observability page shows. */
export class ServerBusyError extends Error {
  public constructor() {
    super(
      `The server did not answer in ${READ_TIMEOUT_MS / 1000} s; it may be busy. Observability → Now shows what it is doing.`,
    );
  }
}

// Reads time out; a request that asks an AI or changes something waits as long as it takes, and has
// its own Stop where it can run long.
const isRead = (method: string, url: string): boolean =>
  method === 'GET' || /\/(auth\/verify|metadata\/coverage)$/.test(url);

async function call<T>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = !signal && isRead(method, url) ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined;
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? timeout,
    });
  } catch (error) {
    if (timeout?.aborted) throw new ServerBusyError();
    throw error;
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // A proxy or a crashed server answers with HTML; the status says more than its body would.
    parsed = {};
  }
  if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `The server answered ${res.status}.`);
  return parsed as T;
}

export type Descendants = { count: number; descendantIds: string[]; titles: string[] };
/** Pages chosen as a chat chooses them: directories with every page under them, single pages, and tags. */
export type Chosen = { dirs?: string[]; pageIds?: string[]; tags?: string[] };
/**
 * How many of some pages are in the AI index, and whether all of them fit one request; while the
 * space's search index is still being built, how far that has got instead.
 */
export type Coverage = {
  pages: number;
  missing: number;
  /** About how many requests indexing the missing pages would take. */
  requests?: number;
  fits?: boolean;
  indexing?: { done: number; total: number };
  /** How many images the pages hold, and the space's choice about sending them (ADR-066). */
  images?: { found: number; choice: ImageChoice };
};
export type DraftSummary = AiSessionView & { turnCount: number };

export const api = {
  connection: () => call<ConnectionView>('/connection'),
  saveConnection: (update: ConnectionUpdate) => call<ConnectionView>('/connection', 'PUT', update),
  verify: (candidate: ConnectionUpdate = {}) => call<AuthVerifyResponse>('/auth/verify', 'POST', candidate),

  spaces: () => call<{ spaces: ConfluenceSpace[] }>('/spaces').then((r) => r.spaces),
  space: (spaceKey: string) => call<ConfluenceSpace>(`/spaces/detail/${key(spaceKey)}`),
  tree: (spaceKey: string) => call<PageTreeResponse>(`/spaces/${key(spaceKey)}/pages`).then((r) => r.tree),
  resolve: (input: string) => call<ResolveResponse>('/spaces/resolve-url', 'POST', { input }),
  page: (pageId: string, spaceKey: string) =>
    call<PageResponse>(`/pages/${key(pageId)}?${new URLSearchParams({ spaceKey })}`),

  synced: () => call<{ spaces: SyncedSpace[] }>('/space-cache/cached').then((r) => r.spaces),
  sync: (spaceKey: string) => call<SyncProgress>('/space-cache/sync', 'POST', { spaceKey }),
  syncStatus: (jobId: string) => call<SyncProgress>(`/space-cache/sync/status/${key(jobId)}`),
  cancelSync: (jobId: string) => call(`/space-cache/sync/cancel/${key(jobId)}`, 'POST'),
  activeSync: (spaceKey: string) =>
    call<{ activeJob: SyncProgress | null }>(`/space-cache/${key(spaceKey)}/sync/active`).then((r) => r.activeJob),
  toc: (spaceKey: string) => call<{ toc: SpaceTocNode[] }>(`/space-cache/${key(spaceKey)}/toc`).then((r) => r.toc),
  zipUrl: (spaceKey: string) => `/api/space-cache/${key(spaceKey)}/zip`,
  purgeStale: (spaceKey: string) => call<PurgeResult>(`/space-cache/${key(spaceKey)}/cache/purge`, 'POST'),
  purgePage: (spaceKey: string, pageId: string, options: { includeSubPages: boolean; addToIgnore: boolean }) =>
    call<{ purgedCount: number }>(`/space-cache/${key(spaceKey)}/pages/${key(pageId)}/purge`, 'POST', options),
  descendants: (spaceKey: string, pageId: string) =>
    call<Descendants>(`/space-cache/${key(spaceKey)}/pages/${key(pageId)}/descendants`),
  excluded: (spaceKey: string, pageId: string) =>
    call<{ isExcluded: boolean }>(`/space-cache/${key(spaceKey)}/pages/${key(pageId)}/exclusion-status`).then(
      (r) => r.isExcluded,
    ),
  ignore: (spaceKey: string) => call<IgnoreRules>(`/space-cache/${key(spaceKey)}/ignore`).then((r) => r.patterns),
  saveIgnore: (spaceKey: string, patterns: string[], purge: boolean) =>
    call<IgnoreRules & { purged?: PurgeResult }>(`/space-cache/${key(spaceKey)}/ignore`, 'POST', { patterns, purge }),
  guard: (spaceKey: string) => call<{ text: string }>(`/space-cache/${key(spaceKey)}/guard`).then((r) => r.text),
  saveGuard: (spaceKey: string, text: string) =>
    call<{ text: string }>(`/space-cache/${key(spaceKey)}/guard`, 'POST', { text }).then((r) => r.text),

  metadata: (spaceKey: string, pageId: string) =>
    call<{ metadata: PageMetadata | null }>(`/space-cache/${key(spaceKey)}/pages/${key(pageId)}/metadata`).then(
      (r) => r.metadata,
    ),
  generatePageMetadata: (spaceKey: string, pageId: string) =>
    call<{ metadata: PageMetadata }>(
      `/space-cache/${key(spaceKey)}/pages/${key(pageId)}/metadata/generate`,
      'POST',
    ).then((r) => r.metadata),
  generateMetadata: (spaceKey: string, rootPageId?: string, chosen?: Chosen) =>
    call<MetadataProgress>(`/space-cache/${key(spaceKey)}/metadata/generate`, 'POST', { rootPageId, ...chosen }),
  metadataStatus: (jobId: string) => call<MetadataProgress>(`/space-cache/metadata/status/${key(jobId)}`),
  activeMetadata: (spaceKey: string) =>
    call<{ activeJob: MetadataProgress | null }>(`/space-cache/${key(spaceKey)}/metadata/active`).then(
      (r) => r.activeJob,
    ),
  summaryCoverage: (spaceKey: string, body: { rootPageId?: string } & Chosen) =>
    call<Coverage>(`/space-cache/${key(spaceKey)}/metadata/coverage`, 'POST', body),
  cancelMetadata: (jobId: string) => call(`/space-cache/metadata/cancel/${key(jobId)}`, 'POST'),

  gitlab: () => call<GitLabView>('/gitlab'),
  saveGitlab: (update: { baseUrl?: string; token?: string }) => call<GitLabView>('/gitlab', 'PUT', update),
  testGitlab: (candidate: { baseUrl?: string; token?: string }) =>
    call<{ ok: boolean; user?: { username: string; name: string }; error?: string }>('/gitlab/test', 'POST', candidate),
  aiSettings: () => call<AiSettingsView>('/ai/settings'),
  saveAiSettings: (update: Record<string, unknown>) => call<AiSettingsView>('/ai/settings', 'PUT', update),
  aiModels: (provider: string) => call<{ models: string[] }>(`/ai/models/${key(provider)}`).then((r) => r.models),
  aiStatus: () => call<{ available: boolean; engine: string }>('/ai/status'),
  aiTest: () => call<{ ok: boolean; engine: string; answer?: string; error?: string }>('/ai/test', 'POST'),
  askSpace: (spaceKey: string, prompt: string) =>
    call<AnalyzeResponse>(`/space-cache/${key(spaceKey)}/ai/ask`, 'POST', { prompt }),

  /** Whether a space's images go to the AI (ADR-066). */
  spaceSettings: (spaceKey: string) => call<{ images: ImageChoice }>(`/space-cache/${key(spaceKey)}/space-settings`),
  saveSpaceSettings: (spaceKey: string, images: ImageChoice) =>
    call<{ images: ImageChoice }>(`/space-cache/${key(spaceKey)}/space-settings`, 'POST', { images }),
  /** A space's tags, or how far its page catalog has got while it is first built (ADR-064). */
  tags: (spaceKey: string) => call<TagsResponse>(`/space-cache/${key(spaceKey)}/tags`),
  /** The staged pages of every chat in a space, for its push queue. */
  staged: (spaceKey: string) =>
    call<{ staged: StagedPage[] }>(`/space-cache/${key(spaceKey)}/staged`).then((r) => r.staged),
};

/** The edit a question is about, while the person has it open. */
export type Focus = { runId: string; pageId: string; title: string };

const SESSIONS = '/ai/sessions';

export const sessions = {
  latest: async (scope: SessionScope): Promise<AiSessionView | null> => {
    const q = new URLSearchParams({
      kind: scope.kind,
      spaceKey: scope.spaceKey,
      ...(scope.pageId ? { pageId: scope.pageId } : {}),
    });
    const { sessions: found } = await call<{ sessions: Array<{ id: string }> }>(`${SESSIONS}?${q}`);
    return found.length ? call<AiSessionView>(`${SESSIONS}/${found[0].id}`) : null;
  },
  get: (id: string) => call<AiSessionView>(`${SESSIONS}/${key(id)}`),
  create: (scope: SessionScope) => call<AiSessionView>(SESSIONS, 'POST', { scope }),
  /** A space's conversations, newest first, without their turns. */
  inSpace: (spaceKey: string) =>
    call<{ sessions: DraftSummary[] }>(`${SESSIONS}?${new URLSearchParams({ kind: 'space,pages', spaceKey })}`).then(
      (r) => r.sessions,
    ),
  /** Asks for suggestions; for more pages than one request carries, a batched review starts instead (ADR-051). */
  suggest: (id: string, kind: 'review' | 'changes', signal?: AbortSignal) =>
    call<AiSessionView & { batch?: BatchProgress }>(`${SESSIONS}/${key(id)}/suggest`, 'POST', { kind }, signal),
  batch: (id: string) => call<{ batch: BatchProgress | null }>(`${SESSIONS}/${key(id)}/batch`),
  /** The step a question is on while it is being answered. */
  activity: (id: string) => call<{ step: string | null; ms?: number }>(`${SESSIONS}/${key(id)}/activity`),
  /** The chat's review queue, and the runs of edits made from it (ADR-060). */
  queue: (id: string) => call<ChatQueue>(`${SESSIONS}/${key(id)}/queue`),
  recommend: (id: string, ids: string[]) =>
    call<BranchRun>(`${SESSIONS}/${key(id)}/suggestions/recommend`, 'POST', { ids }),
  dismiss: (id: string, ids: string[], undo = false) =>
    call<ChatQueue>(`${SESSIONS}/${key(id)}/suggestions/dismiss`, 'POST', { ids, undo }),
  revert: (id: string, suggestionId: string, to: number) =>
    call<ChatQueue>(`${SESSIONS}/${key(id)}/suggestions/${key(suggestionId)}/revert`, 'POST', { to }),
  acceptEdit: (id: string, turn: number) =>
    call<{ session: AiSessionView; run: BranchRun }>(`${SESSIONS}/${key(id)}/turns/${turn}/accept-edit`, 'POST'),
  dismissEdit: (id: string, turn: number) =>
    call<AiSessionView>(`${SESSIONS}/${key(id)}/turns/${turn}/close-proposal`, 'POST'),
  update: (id: string, patch: { title?: string; scope?: Partial<SessionScope> }) =>
    call<AiSessionView>(`${SESSIONS}/${key(id)}`, 'PATCH', patch),
  remove: (id: string) => call<{ deleted: boolean }>(`${SESSIONS}/${key(id)}`, 'DELETE'),
  /** Asks a question; `thorough` reads many sections over several requests, as a job (design doc 0008). */
  send: (id: string, prompt: string, signal?: AbortSignal, thorough = false, focus?: Focus) =>
    call<AiSessionView & { batch?: BatchProgress }>(
      `${SESSIONS}/${key(id)}/messages`,
      'POST',
      {
        prompt,
        ...(thorough ? { thorough } : {}),
        ...(focus ? { focus: { runId: focus.runId, pageId: focus.pageId } } : {}),
      },
      signal,
    ),
  addFile: async (id: string, file: File): Promise<AiSessionView> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const { session } = await call<{ session: AiSessionView }>(`${SESSIONS}/${key(id)}/files`, 'POST', {
      name: file.name,
      data: btoa(binary),
    });
    return session;
  },
  removeFile: (id: string, fileId: string) =>
    call<AiSessionView>(`${SESSIONS}/${key(id)}/files/${key(fileId)}`, 'DELETE'),
};

const RUNS = '/branches/runs';

/** What the app has recorded about itself, for the Observability page (design doc 0008). */
export const observability = {
  now: () => call<ObserveNow>('/observe/now'),
  logs: (params: Record<string, string>) => call<LogPage>(`/observe/logs?${new URLSearchParams(params).toString()}`),
  trace: (traceId: string) => call<{ spans: SpanRecord[]; events: ObservedEvent[] }>(`/observe/traces/${key(traceId)}`),
};
export type ObserveNow = {
  jobs: LiveJob[];
  inflight: Array<{ method: string; path: string; ms: number; traceId: string }>;
  lagMs: { p50: number; max: number };
  points: MetricRecord[];
  problems: ProblemRecord[];
};

/** Batched reviews of more pages than one request carries. */
export const batches = {
  get: (jobId: string) => call<BatchProgress>(`/ai/batches/${key(jobId)}`),
  cancel: (jobId: string) => call<{ cancelled: boolean }>(`/ai/batches/${key(jobId)}/cancel`, 'POST'),
};

export const branches = {
  get: (id: string) => call<BranchRun>(`${RUNS}/${key(id)}`),
  cancel: (id: string) => call<BranchRun>(`${RUNS}/${key(id)}/cancel`, 'POST'),
  decideChange: (id: string, pageId: string, changeId: string, decision: 'accept' | 'reject' | 'undo') =>
    call<BranchRun>(`${RUNS}/${key(id)}/items/${key(pageId)}/changes/${key(changeId)}`, 'PATCH', { decision }),
  decideAll: (id: string, pageId: string, decision: 'accept' | 'reject') =>
    call<BranchRun>(`${RUNS}/${key(id)}/items/${key(pageId)}/decide-all`, 'POST', { decision }),
  saveText: (id: string, pageId: string, text: string) =>
    call<BranchRun>(`${RUNS}/${key(id)}/items/${key(pageId)}/text`, 'PUT', { text }),
  reset: (id: string, pageId: string) => call<BranchRun>(`${RUNS}/${key(id)}/items/${key(pageId)}/reset`, 'POST'),
  redo: (id: string, pageId: string) => call<BranchRun>(`${RUNS}/${key(id)}/items/${key(pageId)}/redo`, 'POST'),
  stage: (id: string, pageId: string, staged: boolean) =>
    call<BranchRun>(`${RUNS}/${key(id)}/items/${key(pageId)}/stage`, 'POST', { staged }),
  check: (id: string, pageIds: string[]) => call<BranchRun>(`${RUNS}/${key(id)}/check`, 'POST', { pageIds }),
  push: (id: string, pageIds: string[]) => call<BranchRun>(`${RUNS}/${key(id)}/push`, 'POST', { pageIds }),
};

const DRAFTS = '/drafts';

export const drafts = {
  start: (body: { spaceKey: string; parentId: string; title: string; notes: string }) =>
    call<AiSessionView>(DRAFTS, 'POST', body),
  unfinished: (spaceKey: string) =>
    call<{ sessions: DraftSummary[] }>(`${SESSIONS}?${new URLSearchParams({ kind: 'draft', spaceKey })}`).then((r) =>
      r.sessions.filter((s) => !s.draft?.createdPageId),
    ),
  recheck: (id: string) => call<AiSessionView>(`${DRAFTS}/${key(id)}/recheck`, 'POST'),
  closeProposal: (id: string, turn: number) =>
    call<AiSessionView>(`${DRAFTS}/${key(id)}/turns/${turn}/close-proposal`, 'POST'),
  decide: (id: string, decision: RedundancyDecision, linkedPageIds: string[]) =>
    call<AiSessionView>(`${DRAFTS}/${key(id)}/decision`, 'POST', { decision, linkedPageIds }),
  addRepository: (id: string, link: string) =>
    call<AiSessionView>(`${DRAFTS}/${key(id)}/repositories`, 'POST', { link }),
  save: (
    id: string,
    patch: {
      title?: string;
      markdown?: string;
      examplePageId?: string;
      template?: string;
      children?: Array<{ title: string; markdown: string }>;
    },
  ) => call<AiSessionView>(`${DRAFTS}/${key(id)}`, 'PUT', patch),
  send: (id: string, prompt: string, signal?: AbortSignal) =>
    call<AiSessionView>(`${DRAFTS}/${key(id)}/messages`, 'POST', { prompt }, signal),
  check: (id: string) => call<unknown>(`${DRAFTS}/${key(id)}/check`, 'POST'),
  create: (id: string) => call<AiSessionView>(`${DRAFTS}/${key(id)}/create`, 'POST'),
};

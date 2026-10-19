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
  AiSessionView,
  AiSettingsView,
  AnalyzeResponse,
  AuthVerifyResponse,
  BranchRun,
  ConfluenceSpace,
  ConnectionUpdate,
  ConnectionView,
  IgnoreRules,
  MetadataProgress,
  PageMetadata,
  PageResponse,
  PageTreeResponse,
  PurgeResult,
  RecommendationResponse,
  RedundancyDecision,
  ResolveResponse,
  SessionScope,
  SpaceTocNode,
  SyncedSpace,
  SyncProgress,
  WriteResult,
} from '../../../src/api/types.js';

const key = encodeURIComponent;

async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

export type BranchRunSummary = Omit<BranchRun, 'items' | 'findings' | 'reportText'> & { pages: number };
export type Descendants = { count: number; descendantIds: string[]; titles: string[] };
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
  parse: (storageXml: string) => call<{ markdown: string }>('/parse', 'POST', { storageXml }),

  synced: () => call<{ spaces: SyncedSpace[] }>('/space-cache/cached').then((r) => r.spaces),
  sync: (spaceKey: string) => call<SyncProgress>('/space-cache/sync', 'POST', { spaceKey }),
  syncStatus: (jobId: string) => call<SyncProgress>(`/space-cache/sync/status/${key(jobId)}`),
  cancelSync: (jobId: string) => call(`/space-cache/sync/cancel/${key(jobId)}`, 'POST'),
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
  generateMetadata: (spaceKey: string, rootPageId?: string) =>
    call<MetadataProgress>(`/space-cache/${key(spaceKey)}/metadata/generate`, 'POST', { rootPageId }),
  metadataStatus: (jobId: string) => call<MetadataProgress>(`/space-cache/metadata/status/${key(jobId)}`),
  activeMetadata: (spaceKey: string) =>
    call<{ activeJob: MetadataProgress | null }>(`/space-cache/${key(spaceKey)}/metadata/active`).then(
      (r) => r.activeJob,
    ),
  cancelMetadata: (jobId: string) => call(`/space-cache/metadata/cancel/${key(jobId)}`, 'POST'),

  aiSettings: () => call<AiSettingsView>('/ai/settings'),
  saveAiSettings: (update: Record<string, unknown>) => call<AiSettingsView>('/ai/settings', 'PUT', update),
  aiModels: (provider: string) => call<{ models: string[] }>(`/ai/models/${key(provider)}`).then((r) => r.models),
  aiStatus: () => call<{ available: boolean; engine: string }>('/ai/status'),
  aiTest: () => call<{ ok: boolean; engine: string; answer?: string; error?: string }>('/ai/test', 'POST'),
  askSpace: (spaceKey: string, prompt: string) =>
    call<AnalyzeResponse>(`/space-cache/${key(spaceKey)}/ai/ask`, 'POST', { prompt }),

  recommend: (pageId: string, body: { spaceKey: string; focusArea: string; prompt?: string }) =>
    call<RecommendationResponse>(`/pages/${key(pageId)}/recommend`, 'POST', body),
  dryRun: (pageId: string, body: { markdown: string; spaceKey: string; baseVersion: number }) =>
    call<WriteResult>(`/pages/${key(pageId)}/dry-run`, 'POST', body),
  push: (pageId: string, body: { markdown: string; spaceKey: string; baseVersion: number }) =>
    call<WriteResult>(`/pages/${key(pageId)}/push`, 'POST', body),
};

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
  send: (id: string, prompt: string) => call<AiSessionView>(`${SESSIONS}/${key(id)}/messages`, 'POST', { prompt }),
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

export const branches = {
  start: (body: {
    kind: 'review' | 'improve';
    spaceKey: string;
    pageId: string;
    focus?: string;
    instructions?: string;
  }) => call<BranchRun>(RUNS, 'POST', body),
  list: (spaceKey: string, pageId: string) =>
    call<{ runs: BranchRunSummary[] }>(`${RUNS}?${new URLSearchParams({ spaceKey, pageId })}`).then((r) => r.runs),
  get: (id: string) => call<BranchRun>(`${RUNS}/${key(id)}`),
  cancel: (id: string) => call<BranchRun>(`${RUNS}/${key(id)}/cancel`, 'POST'),
  decide: (id: string, pageId: string, decision: 'accept' | 'reject' | 'reset', proposed?: string) =>
    call<BranchRun>(`${RUNS}/${key(id)}/items/${key(pageId)}`, 'PATCH', { decision, proposed }),
  check: (id: string) => call<BranchRun>(`${RUNS}/${key(id)}/check`, 'POST'),
  push: (id: string) => call<BranchRun>(`${RUNS}/${key(id)}/push`, 'POST'),
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
  decide: (id: string, decision: RedundancyDecision, linkedPageIds: string[]) =>
    call<AiSessionView>(`${DRAFTS}/${key(id)}/decision`, 'POST', { decision, linkedPageIds }),
  save: (id: string, patch: { title?: string; markdown?: string }) =>
    call<AiSessionView>(`${DRAFTS}/${key(id)}`, 'PUT', patch),
  send: (id: string, prompt: string) => call<AiSessionView>(`${DRAFTS}/${key(id)}/messages`, 'POST', { prompt }),
  check: (id: string) => call<unknown>(`${DRAFTS}/${key(id)}/check`, 'POST'),
  create: (id: string) => call<AiSessionView>(`${DRAFTS}/${key(id)}/create`, 'POST'),
};

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

import type { ManifestSummary } from '../ai/manifest.js';

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
  startedAt?: string;
  completedAt?: string;
  traceId?: string;
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
  /** How many requests the AI index sends at once. */
  parallel: number;
  /** Which provider embeds sections for search by meaning (design doc 0008). */
  embeddings: AiEmbeddings;
};

/**
 * Who embeds sections for search by meaning: the chat provider when it can (`chat`), the OpenAI or
 * Gemini API with its own key whatever answers questions, or nobody (`none`).
 */
export type AiEmbeddings = 'chat' | 'openai' | 'gemini' | 'none';

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
  /** Every attachment of the pages read: what was read, and what was not, with why (ADR-069). */
  attachments?: AttachmentsReport;
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
  /** 2 for metadata with the fields below (ADR-051); absent on the first kind, which is regenerated. */
  version?: number;
  /** Who reads the page, such as "on-call engineers". */
  audience?: string;
  /** The questions the page answers, which a question about the space is matched against. */
  questions?: string[];
  /** One line on each section, in the order `splitSections` gives them. */
  sections?: Array<{ heading: string; summary: string }>;
};

/** The progress of generating AI summaries for a space, polled while it runs. */
export type MetadataProgress = {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  spaceKey: string;
  /** The page whose section is being summarised; absent for the whole space. */
  rootPageId?: string;
  rootTitle?: string;
  /** The run is for a list of chosen pages, such as a chat's. */
  chosen?: boolean;
  total: number;
  processed: number;
  errorCount: number;
  /** How many requests the run needs, with several small pages to a request, and how many are done. */
  requests?: number;
  requestsDone?: number;
  /** The pages left out, each with why; the latest 200. */
  failures?: Array<{ pageId: string; title: string; error: string }>;
  currentPageTitle?: string;
  startedAt?: string;
  completedAt?: string;
  traceId?: string;
};

/** What a conversation is about: one page, a page and everything below it, or a whole space. */
export type SessionScope = {
  /**
   * What a chat reads: one page, a page and everything under it (`branch`), pages the person chose
   * (`pages`), or the whole space. A draft is the conversation behind a new page, started through
   * `/api/drafts`.
   */
  kind: 'page' | 'branch' | 'pages' | 'space' | 'draft';
  spaceKey: string;
  pageId?: string;
  /** For chosen pages: directories, each read with every page under it at the time of asking (ADR-051). */
  dirs?: string[];
  /** For chosen pages: single pages. */
  pageIds?: string[];
  /** For chosen pages: tags, each read as every page that carries it at the time of asking. */
  tags?: string[];
  title?: string;
};

export type SessionTurn = {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** On an answer: what the outbound guard removed, and which pages were left out of the context. */
  guardSummary?: string;
  engine?: string;
  /**
   * The pages an answer read, each with why it was chosen when the AI chose it, and the sections read
   * when only some of the page was (ADR-048, ADR-051).
   */
  matchedPages?: Array<{
    id: string;
    title: string;
    score: number;
    why?: string;
    sections?: Array<{ index: number; heading: string }>;
  }>;
  /** For a retrieved answer: how many candidate sections were looked at. */
  considered?: number;
  /**
   * How many pages the chat reads from, and whether they were read in full, retrieved from, or read
   * in full over several requests (`batched`, with how many). A thorough answer is retrieved over
   * several requests, so it is `retrieved` with `batches` set.
   */
  corpus?: { pages: number; mode: 'full' | 'retrieved' | 'batched'; batches?: number };
  /** The trace that recorded how this answer was made, for the Observability page (ADR-054). */
  traceId?: string;
  /** What was sent to the model for this answer, and what was left out with why (ADR-054). */
  sent?: ManifestSummary;
  /** The model stopped before finishing this answer. */
  cutOff?: 'length' | 'blocked';
  /** The sections found shared few of the question's words, so the answer may not be about it. */
  weakMatch?: boolean;
  /** On a co-writer's answer: the complete revised draft it proposed, for the author to accept or dismiss. */
  proposedDraft?: string;
  /** On a co-writer's answer: a proposed series, an overview page then its child pages. */
  proposedSeries?: SeriesPage[];
  /** On an answer about an open edit: the complete revised text it proposed for that page. */
  proposedEdit?: { runId: string; pageId: string; title: string; text: string };
  /** The author accepted or dismissed this answer's proposal, so it is not offered again. */
  proposalClosed?: boolean;
  /** The images on the pages this answer read: how many, how many were sent, and the space's choice. */
  images?: ImagesReport;
  /** Every attachment of the pages this answer read: what was read, and what was not, with why (ADR-069). */
  attachments?: AttachmentsReport;
  /** On an answer that changed the chat's suggestions: how many it added, updated and removed. */
  queued?: { added: number; updated: number; removed: number };
};

/**
 * A suggestion in a chat's review queue (ADR-060). Its state beyond open or dismissed (being edited,
 * edited, already done, no longer relevant) is read from the runs made from it, not stored here.
 */
export type QueuedSuggestion = BranchFinding & {
  /** 12 hex characters, which the chat and the browser name it by. */
  id: string;
  /** The pages it names, by title, with their ids. */
  pageIds: Record<string, string>;
  /** The version of each named page when it was suggested, so a page changed since is checked again. */
  seenVersions: Record<string, number>;
  fromTurn: number;
  /** Earlier wordings, newest last, each with the turn that changed it. */
  history?: Array<{ detail: string; suggestion?: string; turn: number }>;
  dismissed?: 'you' | 'chat';
};

/** A queued suggestion with the state the chat's runs give it. */
export type SuggestionView = QueuedSuggestion & {
  state:
    | 'open'
    | 'writing'
    | 'to-decide'
    | 'staged'
    | 'pushed'
    | 'failed'
    | 'rejected'
    | 'skipped'
    | 'done'
    | 'not-relevant'
    | 'dismissed';
  /** Why it is done, not relevant or skipped, from the check against the page as it is now. */
  why?: string;
  runId?: string;
  /** The pages its edits are on, in that run. */
  editPageIds?: string[];
  /** Its edit was made from an earlier wording of it. */
  outdated?: boolean;
};

/** A chat's queues: its suggestions and the runs of edits made from them. */
export type ChatQueue = { suggestions: SuggestionView[]; runs: BranchRun[] };

/** A staged page ready to push, with the chat it came from, for the space's push queue. */
export type StagedPage = {
  sessionId: string;
  chatTitle: string;
  /** For a page's chat, the page, whose Chat tab holds it; a Space chat has none. */
  chatPageId?: string;
  runId: string;
  pageId: string;
  title: string;
  accepted: number;
  status: BranchItemStatus;
  message?: string;
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
  /** On a draft conversation: the page being written. */
  draft?: DraftState;
  /** The chat's review queue (ADR-060). */
  suggestions?: QueuedSuggestion[];
  /** The runs of edits made from the chat's suggestions, oldest first. */
  runIds?: string[];
  /** Whether the chat reads its pages' attachments; unanswered, it does, and asks (ADR-069). */
  attachments?: AttachmentChoice;
};

/** An existing page that may already say what a new page is meant to. */
export type SimilarPage = {
  pageId: string;
  title: string;
  spaceKey: string;
  score: number;
  /** Where it was found: the synced copy, or Confluence's own search. */
  source: 'synced' | 'confluence';
  excerpt?: string;
  /** The AI's judgement of the overlap, when an AI is set up. */
  overlap?: 'high' | 'some' | 'low';
  why?: string;
};

export type RedundancyDecision = 'update-existing' | 'link' | 'continue';

/** A new page while it is being written, and the check for pages that may already say it (ADR-025). */
export type DraftState = {
  title: string;
  parentId: string;
  parentTitle?: string;
  notes: string;
  /** An existing page whose structure the new page follows, such as another service's docs. */
  examplePageId?: string;
  /** A structure for the new page, pasted by the author. */
  template?: string;
  /** Pages created under the new page with it, in order, when the draft is a series. */
  children?: SeriesPage[];
  markdown: string;
  redundancy?: {
    checkedAt: string;
    similar: SimilarPage[];
    /** The author's answer. A page is not created until there is one (ADR-025). */
    decision?: RedundancyDecision;
    linkedPageIds?: string[];
    decidedAt?: string;
    /** Why part of the check could not run, when it could not. */
    note?: string;
  };
  createdPageId?: string;
  createdUrl?: string;
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
  /** Reading the page from Confluence and checking its suggestions still apply (ADR-061). */
  | 'checking'
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

/** A suggestion an edit is asked to apply, with the other pages it names. */
export type BranchFix = {
  kind: BranchFinding['kind'];
  detail: string;
  suggestion?: string;
  otherPages: string[];
  /** The part a person must do in Confluence, which the edit leaves alone (ADR-068). */
  byHand?: string;
  /** The chat suggestion it came from, worded as it was when the edit was made. */
  suggestionId?: string;
  /** The page's version when it was suggested. */
  seenVersion?: number;
};

/** A part of a page the text stands in for with a marker, such as a macro or an image (ADR-058). */
export type PagePart = {
  n: number;
  label: string;
  kind: 'inline' | 'block' | 'container';
  /** Its picture's place in the page's attachments, an image or a diagram's preview (ADR-068). */
  picture?: number;
};

/** One change in an edit of a page, decided on its own (ADR-059). */
export type PageChange = {
  /** Stays the same while the change does, so a decision survives edits elsewhere. */
  id: string;
  /** The page's text the change replaces, empty for an addition. */
  before: string;
  /** The text it puts there, empty for a removal. */
  after: string;
  /** Whether the model suggested it, or the person wrote it. */
  source: 'ai' | 'yours';
  /** What else accepting it does, such as removing a macro. */
  notes: string[];
  /** Why the change cannot be written as it is. */
  problem?: string;
  decision: 'pending' | 'accepted' | 'rejected';
};

/** One page in a run of staged edits: its proposed edit, and the person's decisions on its changes. */
export type BranchItem = {
  pageId: string;
  title: string;
  /** The page version the proposal was made from; a push is refused if the page has moved on. */
  baseVersion: number;
  status: BranchItemStatus;
  /** The page as the model was given it, its edit form (ADR-058); unset until the page is read. */
  original?: string;
  /** The model's edit, kept as it was, so the working text can be reset to it. */
  suggested?: string;
  /** The working text: the model's edit with the person's own changes to it. */
  proposed?: string;
  /** The parts of the page its markers stand for. */
  parts?: PagePart[];
  /** Formatting each block of the page's text cannot hold, by block, lost if that block is rewritten. */
  drops?: Record<number, string[]>;
  /** The changes from the page to the working text, each with its decision. */
  changes?: PageChange[];
  /** The page in order, as unchanged blocks and changes, so the two can be shown side by side. */
  rows?: Array<{ same: string } | { change: string }>;
  /** The decisions made, by change id. */
  decisions?: Record<string, 'accepted' | 'rejected'>;
  /** What a push writes: the page's text with only the accepted changes applied. */
  result?: string;
  critique?: string[];
  changelog?: string[];
  /** Why a page was skipped or a step failed, in words a person can act on. */
  message?: string;
  guardSummary?: string;
  pushedVersion?: number;
  /** The suggestions this page's edit applies. */
  fixes?: BranchFix[];
  /** The last revision the chat proposed and the person accepted, which counts as the AI's. */
  refined?: string;
  /** What happened to the page's edit so far, each step with when it began, for the person to follow. */
  steps?: Array<{ at: string; text: string }>;
  /** The images on the page, and whether they were sent with the request for its edit (ADR-066). */
  images?: ImagesReport;
  /** While the edit is written, and the provider streams it: how long the answer is, and its end. */
  writing?: { chars: number; tail: string };
  /** Picked to be pushed; any later change to the edit unpicks it, so what is pushed was looked at. */
  staged?: boolean;
  /**
   * The check made before the edit (ADR-061): the version read, and for each suggestion made before
   * the page changed, whether it still applies.
   */
  freshness?: {
    version: number;
    verdicts: Array<{
      suggestionId?: string;
      detail: string;
      verdict: 'applies' | 'done' | 'not-relevant';
      why?: string;
    }>;
  };
};

/** Something a review found that a maintainer should fix. */
export type BranchFinding = {
  kind:
    | 'incorrect'
    | 'redundant'
    | 'stale'
    | 'clarity'
    | 'depth'
    | 'structure'
    | 'operations'
    /** A page in the wrong place, or one to split or merge: no edit of one page does it. */
    | 'placement'
    /** A page that should exist and does not: no edit of an existing page does it. */
    | 'gap';
  pages: string[];
  detail: string;
  suggestion?: string;
  /** What a person must change in Confluence, such as redrawing a diagram, which no edit can (ADR-068). */
  byHand?: string;
  /** Set when that is all of it, so there is nothing for an edit to do. */
  byHandOnly?: boolean;
};

/** One page of a series written with the co-writer: its title, its Markdown, and once created, its id. */
export type SeriesPage = {
  title: string;
  markdown: string;
  /** Existing pages with a similar title, found when the page was added to the series. */
  similar?: Array<{ pageId: string; title: string }>;
  createdPageId?: string;
};

/** The GitLab connection, as a browser may see it: never the token (ADR-050). */
export type GitLabView = { baseUrl: string; tokenSet: boolean };

/** Whether a space's images go to the AI: ask whenever pages with images are read, send, or skip (ADR-066). */
export type ImageChoice = 'ask' | 'send' | 'skip';

/** A chat's choice about its pages' attachments: read them with the pages, or read the pages only. */
export type AttachmentChoice = 'include' | 'pages';

/** The account of a set of pages' attachments: each read, with what as, or named with why it was not. */
export type AttachmentsReport = {
  /** How many attachments the pages hold. */
  files: number;
  read: Array<{ page: string; name: string; as: string; cut?: number }>;
  unread: Array<{ page: string; name: string; why: string }>;
  images: ImagesReport;
  /** The chat's choice, once made. */
  choice?: AttachmentChoice;
};
/** What a request did with the images on the pages it read. */
export type ImagesReport = { found: number; sent: number; choice: ImageChoice; left?: string[] };

/** A space's tags, or, while its page catalog is first built, how far that has got (ADR-064). */
export type TagsResponse = { tags: TaggedPages[]; building?: { done: number; total: number } };

/** A tag and the pages that carry it, each with where it sits in the space. */
export type TaggedPages = {
  tag: string;
  pages: Array<{ id: string; title: string; path: string; summary?: string }>;
};

/** What a review looks for, each ticked by the person. */
export type ReviewAspect = 'accuracy' | 'repetition' | 'staleness' | 'clarity' | 'depth' | 'structure' | 'operations';

/** How a review's pages were chosen: one page, a page and everything under it, or a tag (ADR-046). */
export type ReviewSource = { kind: 'page' | 'section'; rootPageId: string } | { kind: 'tag'; tag: string };

/**
 * A review of a set of pages, or the edits staged from its suggestions (ADR-024, ADR-046). A run
 * saved before reviews had a source has none, and is a review of a whole section.
 */
export type BranchRun = {
  id: string;
  kind: 'review' | 'improve';
  spaceKey: string;
  /** The page the review started from; empty for a tag. */
  rootPageId: string;
  /** What the run is about, for its heading: a page's title, or a tag as `#tag`. */
  rootTitle: string;
  source?: ReviewSource;
  aspects?: ReviewAspect[];
  /** For staged edits, the review whose suggestions they apply. */
  fromRunId?: string;
  /** For staged edits, the chat whose suggestions they apply. */
  fromSessionId?: string;
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

/** A review, or a request for changes, over more pages than one request carries, read in batches (ADR-051). */
export type BatchProgress = {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt?: string;
  completedAt?: string;
  traceId?: string;
  sessionId: string;
  spaceKey: string;
  /** A review, a request for changes, or a thorough answer to a question (design doc 0008). */
  kind: 'review' | 'changes' | 'answer';
  /** How many pages are read, and in how many batches. */
  pages: number;
  total: number;
  processed: number;
  /** For a thorough answer: how many sections its batches read. */
  sections?: number;
  /** For a thorough answer: every batch is read, and their notes are being combined into the answer. */
  combining?: boolean;
  /** The first page of the batch being read. */
  currentTitle?: string;
  error?: string;
};

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

// The shapes of the Confluence Server and Data Center REST replies this app reads. Only the fields
// the app uses are declared; Confluence sends many more.

export type RestUser = {
  username: string;
  userKey: string;
  displayName: string;
  email?: string;
};

export type RestSpace = {
  key: string;
  name: string;
  type: string;
  description?: { plain?: { value: string } };
  homepage?: { id: string; title: string };
  _links?: { webui?: string };
};

export type RestList<T> = {
  results?: T[];
  start?: number;
  limit?: number;
  size?: number;
  _links?: { next?: string };
};

export type RestAttachment = {
  id: string;
  title: string;
  metadata?: { mediaType?: string };
  extensions?: { fileSize?: number; mediaType?: string };
  _links?: { download?: string };
};

export type RestContent = {
  id: string;
  title: string;
  space?: { key: string };
  version?: { number: number; by?: { displayName: string }; when: string };
  history?: { lastUpdated?: { by?: { displayName: string }; when: string } };
  ancestors?: Array<{ id: string; title: string }>;
  body?: { storage?: { value: string } };
  metadata?: { labels?: { results: Array<{ name: string }> } };
  children?: { attachment?: { results: RestAttachment[]; _links?: { next?: string } } };
  _links?: { webui?: string };
};

export type RestLicense = { expired: boolean; expiryDate: number };

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

// The colour theme, remembered in this browser.

export type Theme = 'light' | 'dark';
const KEY = 'theme';

function saved(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark'; // Storage blocked: the default theme, for this visit only.
  }
}

export const theme = $state({ current: saved() });

export function applyTheme(): void {
  document.documentElement.setAttribute('data-theme', theme.current);
  try {
    localStorage.setItem(KEY, theme.current);
  } catch {
    // Storage blocked: the theme still applies until the page is closed.
  }
}

export function toggleTheme(): void {
  theme.current = theme.current === 'dark' ? 'light' : 'dark';
  applyTheme();
}

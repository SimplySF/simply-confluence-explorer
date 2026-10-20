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

// A request about a page can finish after the person has opened another one. Its result belongs to
// the page it was asked for, so it is shown only while that page is still the one on screen.

/**
 * Wraps a setter so that it only applies a result while the page it was requested for is current.
 *
 * @param requested The id of the page the request was about.
 * @param current Reads the id of the page on screen now.
 * @param apply Shows the result.
 */
export function forPage<T>(requested: string, current: () => string | undefined, apply: (value: T) => void) {
  return (value: T): void => {
    if (current() === requested) apply(value);
  };
}

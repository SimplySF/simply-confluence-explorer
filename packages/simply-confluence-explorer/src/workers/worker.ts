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

// A worker thread's entry: it runs each task it is sent and posts back the result or why it failed.

import { parentPort } from 'node:worker_threads';
import { errorMessage } from '../util/errors.js';
import { runTask, type Task } from './tasks.js';

parentPort?.on('message', (message: { id: number; task: Task }) => {
  runTask(message.task).then(
    (result) => parentPort?.postMessage({ id: message.id, result }),
    (error: unknown) => parentPort?.postMessage({ id: message.id, error: errorMessage(error) }),
  );
});

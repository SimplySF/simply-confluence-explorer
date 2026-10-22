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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { GuardedPayload } from './guard.js';
import type { Reply } from './reply.js';

// The Gemini CLI is run as `node <its bundle>`, so no shell is involved on any platform. `gemini` on
// PATH is a shim (a .cmd file on Windows, a symlink elsewhere); what runs is the bundle it points at.

const BUNDLE = path.join('node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');

export type CliLookup = {
  configured: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  execPath: string;
  exists(p: string): boolean;
  realpath(p: string): string;
  readdir(p: string): string[];
};

// The bundle reachable from one place: an npm prefix, a bin directory, or a file the person named.
function bundleFrom(dir: string, l: CliLookup): string | null {
  if (dir.endsWith('.js')) return l.exists(dir) ? dir : null;
  if (/gemini(\.cmd)?$/i.test(path.basename(dir))) dir = path.dirname(dir);
  const candidates = [path.join(dir, BUNDLE), path.join(dir, '..', 'lib', BUNDLE)];
  const shim = path.join(dir, l.platform === 'win32' ? 'gemini.cmd' : 'gemini');
  if (l.platform !== 'win32' && l.exists(shim)) candidates.unshift(l.realpath(shim));
  return candidates.find((c) => c.endsWith('.js') && l.exists(c)) ?? null;
}

/** Where the Gemini CLI's bundle is, or null. A configured path wins over discovery. */
export function resolveGeminiCli(l: CliLookup): string | null {
  if (l.configured) return bundleFrom(l.configured, l);

  const dirs = (l.env.PATH ?? l.env.Path ?? '').split(l.platform === 'win32' ? ';' : ':').filter(Boolean);
  if (l.platform === 'win32') {
    if (l.env.APPDATA) dirs.push(path.join(l.env.APPDATA, 'npm'));
    // Portable Node installs unpack to %LOCALAPPDATA%\Programs\node-v<version>-win-x64.
    const programs = l.env.LOCALAPPDATA ? path.join(l.env.LOCALAPPDATA, 'Programs') : '';
    if (programs && l.exists(programs)) {
      for (const name of l.readdir(programs).filter((entry) => /^node-v[\d.]+-win-/.test(entry)))
        dirs.push(path.join(programs, name));
    }
  }
  dirs.push(path.dirname(l.execPath));

  for (const dir of dirs) {
    const found = bundleFrom(dir, l);
    if (found) return found;
  }
  return null;
}

export function systemCliLookup(configured: string, env: NodeJS.ProcessEnv): CliLookup {
  return {
    configured,
    env,
    platform: process.platform,
    execPath: process.execPath,
    exists: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    readdir: (p) => fs.readdirSync(p),
  };
}

// Every account on the machine can read a process's arguments, so the prompt and the page travel on
// standard input instead. The CLI appends piped input to this fixed -p instruction.
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const STDIN_INSTRUCTION =
  'Follow the instructions at the start of the input below, applying them to the document that follows.';

/**
 * What the CLI said on its error output, without its start-up timings and stack frames, which bury
 * the reason, such as a used-up quota or an overloaded model. The reason comes first, so the start
 * is kept when it is long.
 */
export function cliError(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith('[STARTUP]') && !/^\s+at /.test(line))
    .join('\n')
    .slice(0, 1500);
}

/**
 * Runs one guarded prompt with the document on standard input, in a scratch working directory.
 * Aborting `signal` ends the process.
 */
export function runGeminiCli(
  scriptPath: string,
  payload: GuardedPayload,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onText?: (text: string) => void,
): Promise<Reply> {
  const systemPrompt = payload.system;
  // The CLI takes one prompt, so a conversation is written out as a transcript.
  const documentContext =
    payload.messages.length === 1
      ? payload.messages[0].content
      : payload.messages.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`).join('\n\n');
  // Images the space chose to send are written to a folder made for this request, readable only by
  // this account, and named in the fixed instruction with the CLI's @ syntax; page text never goes in
  // the instruction, so no text on a page can make the CLI read a file (ADR-066).
  const images = payload.images ?? [];
  const folder = images.length > 0 ? fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-images-')) : undefined;
  const names = images.map((im, i) => `img-${i + 1}${EXTENSIONS[im.mediaType] ?? '.png'}`);
  if (folder) images.forEach((im, i) => fs.writeFileSync(path.join(folder, names[i]), Buffer.from(im.data, 'base64')));
  const instruction = folder
    ? `${STDIN_INSTRUCTION} Also look at these images from the pages: ${names.map((n) => `@${n}`).join(' ')}`
    : STDIN_INSTRUCTION;
  const tidy = (): void => {
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  };
  return new Promise<Reply>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--skip-trust', '-p', instruction, '-o', 'text'], {
      cwd: folder ?? os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, NO_COLOR: '1' },
      signal,
    });

    // Output is gathered as bytes and decoded once, so a character split between two chunks arrives whole.
    // The text so far is decoded as it comes too, by a decoder that holds back a split character.
    const stdout: Buffer[] = [];
    const decoder = new StringDecoder('utf8');
    let soFar = '';
    const stderr: Buffer[] = [];

    child.stdin.on('error', (err) => reject(new Error(`Gemini CLI closed its input: ${err.message}`)));
    child.stdin.end(`INSTRUCTIONS:\n${systemPrompt}\n\nDOCUMENT:\n${documentContext}`);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (!onText) return;
      soFar += decoder.write(chunk);
      onText(soFar);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) =>
      reject(
        new Error(
          err.name === 'AbortError' ? 'the Gemini CLI was stopped' : `Failed to spawn Gemini CLI: ${err.message}`,
        ),
      ),
    );

    child.on('close', (code) => {
      const stderrData = Buffer.concat(stderr).toString('utf8');
      const cleanOutput = Buffer.concat(stdout)
        .toString('utf8')
        .replace(/Warning:\s*True color[^\r\n]*\r?\n?/gi, '')
        .replace(/Ripgrep is not available[^\r\n]*\r?\n?/gi, '')
        .replace(/YOLO mode is enabled[^\r\n]*\r?\n?/gi, '')
        .trim();
      if (!cleanOutput) {
        // The CLI can end without an answer yet report success, saying why only on its error output.
        const said = cliError(stderrData) || 'it printed no error';
        const sent = images.length ? ` It was sent ${images.length} image${images.length === 1 ? '' : 's'}.` : '';
        reject(
          new Error(
            code === 0
              ? `the Gemini CLI gave no answer: ${said}${sent}`
              : `the Gemini CLI exited with code ${code ?? 'unknown'}: ${said}${sent}`,
          ),
        );
      } else {
        // An answer followed by a failure may be the start of one the CLI could not finish.
        resolve(code === 0 ? { text: cleanOutput } : { text: cleanOutput, cutOff: 'length' });
      }
    });
  }).finally(tidy);
}

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
import { imageLabel, type GuardedPayload } from './guard.js';
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
    .filter(
      (line) =>
        line.trim() && !line.startsWith('[STARTUP]') && !/^\s+at /.test(line) && !NOISE.some((n) => n.test(line)),
    )
    .join('\n')
    .slice(0, 1500);
}

/** Text with every @ escaped as the CLI's `\\@`, so it reads none of them as a file to attach. */
const escapeAt = (text: string): string => text.replace(/@/g, '\\@');
/** An answer with the escapes the model repeated from its input taken out again. */
const unescapeAt = (text: string): string => text.replace(/\\@/g, '@');

/** Lines the CLI prints on every run, on either output, which say nothing about the answer. */
const NOISE = [/Warning:\s*True color/i, /Ripgrep is not available/i, /YOLO mode is enabled/i];

/** The CLI ended as a success without writing an answer; `said` is its reason, when it gave one. */
class NoAnswerError extends Error {
  public constructor(
    message: string,
    public readonly said?: string,
  ) {
    super(message);
  }
}

/** The first line of what the CLI said, without its severity tag, short enough to name beside an image. */
function reasonOf(said: string): string | undefined {
  const line = said
    .split('\n')[0]
    ?.replace(/^\[(ERROR|WARNING)\]\s*/, '')
    .trim();
  return line ? line.slice(0, 300) : undefined;
}

/**
 * Runs one guarded prompt with the document on standard input, in a scratch working directory.
 * Aborting `signal` ends the process. The CLI can end without an answer and without a reason when it
 * is sent images; the prompt is then sent once more without them, and the reply names them as not
 * read, with what the CLI said about the first try, so the answer is never lost to them and they
 * are never claimed as read (ADR-069).
 */
export async function runGeminiCli(
  scriptPath: string,
  payload: GuardedPayload,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onText?: (text: string) => void,
): Promise<Reply> {
  const images = payload.images ?? [];
  try {
    return await runOnce(scriptPath, payload, env, signal, onText);
  } catch (error) {
    if (images.length === 0 || !(error instanceof NoAnswerError)) throw error;
    const reply = await runOnce(scriptPath, { ...payload, images: [] }, env, signal, onText);
    return {
      ...reply,
      imagesDropped: images.map((i) => i.name),
      ...(error.said ? { whyDropped: error.said } : {}),
    };
  }
}

function runOnce(
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
  // The CLI can search and read the files in its working folder, so every request runs in an empty
  // folder made for it, readable only by this account and removed when it ends; a shared folder such
  // as the system's temporary one would let it read other programs' files. Images the space chose to
  // send are written there and named in the fixed instruction with the CLI's @ syntax. The CLI reads
  // @ references in its piped input too, so every @ there is escaped: no text on a page can make it
  // read a file or rewrite the text (ADR-076). It attaches the files in name order, which the
  // two-digit numbers keep the same as the list naming each one.
  const images = payload.images ?? [];
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-gemini-'));
  const names = images.map((im, i) => `img-${String(i + 1).padStart(2, '0')}${EXTENSIONS[im.mediaType] ?? '.png'}`);
  const named = images.length
    ? `\n\nIMAGES, attached after the document in this order:\n${images.map((im, i) => `${names[i]} is ${imageLabel(i, im)}`).join('\n')}`
    : '';
  images.forEach((im, i) => fs.writeFileSync(path.join(folder, names[i]), Buffer.from(im.data, 'base64')));
  const instruction = images.length
    ? `${STDIN_INSTRUCTION} Also look at these images from the pages: ${names.map((n) => `@${n}`).join(' ')}`
    : STDIN_INSTRUCTION;
  // Removed once the process has closed: Windows refuses to remove a folder a process still runs in.
  const tidy = (): void => {
    try {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A folder the system still holds is left in its temporary folder, private to this account;
      // failing the request over it would hide the answer, or why there was none.
    }
  };
  return new Promise<Reply>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--skip-trust', '-p', instruction, '-o', 'text'], {
      cwd: folder,
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
    child.stdin.end(escapeAt(`INSTRUCTIONS:\n${systemPrompt}\n\nDOCUMENT:\n${documentContext}${named}`));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (!onText) return;
      soFar += decoder.write(chunk);
      onText(unescapeAt(soFar));
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      // A process that never started never closes, so its folder is removed here.
      if (child.pid === undefined) tidy();
      reject(
        new Error(
          err.name === 'AbortError' ? 'the Gemini CLI was stopped' : `Failed to spawn Gemini CLI: ${err.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      tidy();
      const stderrData = Buffer.concat(stderr).toString('utf8');
      const cleanOutput = Buffer.concat(stdout)
        .toString('utf8')
        .split(/\r?\n/)
        .filter((line) => !NOISE.some((n) => n.test(line)))
        .join('\n')
        .trim();
      if (!cleanOutput) {
        // The CLI can end without an answer yet report success, saying why only on its error output.
        const reason = cliError(stderrData);
        const said = reason || 'it printed no error';
        const sent = images.length ? ` It was sent ${images.length} image${images.length === 1 ? '' : 's'}.` : '';
        reject(
          code === 0
            ? new NoAnswerError(`the Gemini CLI gave no answer: ${said}${sent}`, reasonOf(reason))
            : new Error(`the Gemini CLI exited with code ${code ?? 'unknown'}: ${said}${sent}`),
        );
      } else {
        // An answer followed by a failure may be the start of one the CLI could not finish.
        const text = unescapeAt(cleanOutput);
        resolve(code === 0 ? { text } : { text, cutOff: 'length' });
      }
    });
  });
}

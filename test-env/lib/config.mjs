import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTENV_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_DIR = path.join(TESTENV_DIR, '.state');
// The data directory the end-to-end suite runs the app with. The seed writes each space's
// .confluenceignore here, as the app would find it in a real data directory.
export const DATA_DIR = path.join(STATE_DIR, 'data');
export const CREDENTIALS_FILE = path.join(STATE_DIR, 'credentials.json');

const raw = JSON.parse(fs.readFileSync(path.join(TESTENV_DIR, 'testenv.config.json'), 'utf-8'));

export const config = {
  ...raw,
  confluenceVersion: process.env.CONFLUENCE_VERSION || raw.confluenceVersion,
  port: Number(process.env.CONFLUENCE_PORT || raw.port),
  jvmMaxMemory: process.env.CONFLUENCE_JVM_MAX || raw.jvmMaxMemory,
};

export const baseUrl = process.env.TESTENV_BASE_URL || `http://localhost:${config.port}`;

export function readLicense() {
  return fs.readFileSync(path.join(TESTENV_DIR, config.licenseFile), 'utf-8').trim();
}

export function readCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeCredentials(creds) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export function log(msg) {
  console.log(`[testenv] ${msg}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import { spawnSync, spawn } from 'node:child_process';
import { config, readLicense, baseUrl, log, sleep } from './config.mjs';

function has(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function hostHasPodman() {
  if (!has('flatpak-spawn')) return false;
  return spawnSync('flatpak-spawn', ['--host', 'podman', '--version'], { stdio: 'ignore' }).status === 0;
}

// podman, then host podman from inside a toolbox, then docker. CONTAINER_RUNTIME overrides.
function detectRuntime() {
  const forced = process.env.CONTAINER_RUNTIME;
  if (forced) return forced === 'host-podman' ? ['flatpak-spawn', '--host', 'podman'] : [forced];
  if (has('podman')) return ['podman'];
  if (hostHasPodman()) return ['flatpak-spawn', '--host', 'podman'];
  if (has('docker')) return ['docker'];
  throw new Error('No container runtime found (podman or docker). Set CONTAINER_RUNTIME.');
}

const runtime = detectRuntime();
const { names } = config;

export function runtimeName() {
  return runtime.join(' ');
}

function rt(args, { allowFail = false, quiet = false } = {}) {
  const res = spawnSync(runtime[0], [...runtime.slice(1), ...args], { encoding: 'utf-8' });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${runtimeName()} ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  }
  if (!quiet && res.stderr && res.status !== 0) process.stderr.write(res.stderr);
  return { ok: res.status === 0, out: (res.stdout || '').trim() };
}

function exists(kind, name) {
  if (kind === 'container') return rt(['container', 'inspect', name], { allowFail: true, quiet: true }).ok;
  if (kind === 'network') return rt(['network', 'inspect', name], { allowFail: true, quiet: true }).ok;
  return rt(['volume', 'inspect', name], { allowFail: true, quiet: true }).ok;
}

export function containerState(name) {
  const r = rt(['container', 'inspect', '-f', '{{.State.Status}}|{{.State.StartedAt}}', name], { allowFail: true, quiet: true });
  if (!r.ok) return null;
  const [status, startedAt] = r.out.split('|');
  return { status, startedAt };
}

function pullIfMissing(image) {
  if (rt(['image', 'inspect', image], { allowFail: true, quiet: true }).ok) return;
  log(`Pulling ${image} (first run only)...`);
  const res = spawnSync(runtime[0], [...runtime.slice(1), 'pull', image], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`Failed to pull ${image}`);
}

export function up() {
  const appImage = `docker.io/atlassian/confluence:${config.confluenceVersion}`;
  pullIfMissing(config.postgresImage);
  pullIfMissing(appImage);

  if (!exists('network', names.network)) rt(['network', 'create', names.network]);

  if (!exists('container', names.db)) {
    log(`Creating ${names.db}`);
    rt([
      'create', '--name', names.db, '--network', names.network,
      '-e', `POSTGRES_USER=${config.db.user}`,
      '-e', `POSTGRES_PASSWORD=${config.db.password}`,
      '-e', `POSTGRES_DB=${config.db.name}`,
      '-e', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --lc-collate=C --lc-ctype=C',
      '-v', `${names.dbVolume}:/var/lib/postgresql/data`,
      config.postgresImage,
    ]);
  }

  if (!exists('container', names.app)) {
    log(`Creating ${names.app} (Confluence ${config.confluenceVersion})`);
    rt([
      'create', '--name', names.app, '--network', names.network,
      '-p', `${config.port}:8090`,
      '-e', 'ATL_DB_TYPE=postgresql',
      '-e', `ATL_JDBC_URL=jdbc:postgresql://${names.db}:5432/${config.db.name}`,
      '-e', `ATL_JDBC_USER=${config.db.user}`,
      '-e', `ATL_JDBC_PASSWORD=${config.db.password}`,
      '-e', `ATL_LICENSE_KEY=${readLicense()}`,
      '-e', 'JVM_MINIMUM_MEMORY=1024m',
      '-e', `JVM_MAXIMUM_MEMORY=${config.jvmMaxMemory}`,
      '-v', `${names.homeVolume}:/var/atlassian/application-data/confluence`,
      appImage,
    ]);
  }

  rt(['start', names.db]);
  rt(['start', names.app]);
  log(`Containers running (${runtimeName()}); Confluence at ${baseUrl}`);
}

export function down() {
  rt(['stop', '-t', '30', names.app], { allowFail: true, quiet: true });
  rt(['stop', names.db], { allowFail: true, quiet: true });
  log('Stopped (data kept).');
}

export function restartApp() {
  rt(['restart', '-t', '30', names.app]);
}

export function reset() {
  rt(['rm', '-f', names.app, names.db], { allowFail: true, quiet: true });
  rt(['volume', 'rm', '-f', names.dbVolume, names.homeVolume], { allowFail: true, quiet: true });
  rt(['network', 'rm', names.network], { allowFail: true, quiet: true });
  log('Removed containers, volumes and network.');
}

export function status() {
  for (const n of [names.db, names.app]) {
    const s = containerState(n);
    console.log(`${n.padEnd(22)} ${s ? `${s.status} (since ${s.startedAt})` : 'not created'}`);
  }
}

export function logs({ follow = true } = {}) {
  const args = ['logs', ...(follow ? ['-f'] : []), names.app];
  return spawn(runtime[0], [...runtime.slice(1), ...args], { stdio: 'inherit' });
}

export function exec(name, cmd) {
  return rt(['exec', name, 'sh', '-c', cmd], { allowFail: true, quiet: true });
}

export async function waitForStatus(accept = ['FIRST_RUN', 'RUNNING'], timeoutMs = 10 * 60_000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/status`);
      const body = await res.json().catch(() => ({}));
      if (body.state && body.state !== last) {
        log(`Confluence state: ${body.state}`);
        last = body.state;
      }
      if (accept.includes(body.state)) return body.state;
    } catch {
      // not listening yet
    }
    await sleep(3000);
  }
  throw new Error(`Confluence did not reach ${accept.join('/')} within ${timeoutMs / 1000}s`);
}

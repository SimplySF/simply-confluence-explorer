#!/usr/bin/env node
// Confluence Data Center test environment CLI.
//
//   node test-env/testenv.mjs <command>   (or pnpm run testenv:<command>)
//
//   start      up + provision + seed (what the end-to-end suite and CI need)
//   up         create/start the Postgres and Confluence containers
//   provision  finish the setup wizard (first run) and issue a PAT
//   seed       create missing spaces/pages and write .confluenceignore files
//   env        print the variables that point the app at this environment
//   status     show container and license status
//   logs       follow the Confluence container log
//   down       stop containers (data kept)
//   reset      delete containers, volumes and generated state
import fs from 'node:fs';
import * as containers from './lib/containers.mjs';
import { provision, licenseDetails } from './lib/provision.mjs';
import { seed } from './lib/seed.mjs';
import { STATE_DIR, readCredentials, baseUrl, log } from './lib/config.mjs';

export async function start() {
  containers.up();
  const creds = await provision();
  await seed(creds.token);
  return creds;
}

export function envLines(creds) {
  return [
    `CONFLUENCE_URL=${creds.baseUrl}`,
    `CONFLUENCE_PERSONAL_TOKEN=${creds.token}`,
    `CONFLUENCE_EXPLORER_DATA=${DATA_DIR}`,
    'CONFLUENCE_EXPLORER_PROFILE=dev',
  ];
}

async function main(cmd) {
  switch (cmd) {
    case 'start':
      await start();
      break;
    case 'up':
      containers.up();
      break;
    case 'provision':
      await provision();
      break;
    case 'seed': {
      const creds = readCredentials() || (await provision());
      await seed(creds.token);
      break;
    }
    case 'env': {
      const creds = readCredentials();
      if (!creds) throw new Error('No credentials yet. Run `node test-env/testenv.mjs start` first.');
      console.log(envLines(creds).join('\n'));
      break;
    }
    case 'status': {
      containers.status();
      const creds = readCredentials();
      const lic = creds ? await licenseDetails(creds.token).catch(() => null) : null;
      console.log(`Confluence ${baseUrl}: ${lic ? `license ${lic.expired ? 'EXPIRED' : 'valid'} until ${new Date(lic.expiryDate).toLocaleString()}` : 'not reachable / not provisioned'}`);
      break;
    }
    case 'logs':
      containers.logs();
      break;
    case 'down':
      containers.down();
      break;
    case 'reset':
      containers.reset();
      fs.rmSync(STATE_DIR, { recursive: true, force: true });
      log('Removed generated state.');
      break;
    default:
      console.error('Usage: node test-env/testenv.mjs start|up|provision|seed|env|status|logs|down|reset');
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2]).catch((e) => {
    console.error(`[testenv] ${e.message}`);
    process.exit(1);
  });
}

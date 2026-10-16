import { config, baseUrl, log, readCredentials, writeCredentials } from './config.mjs';
import { waitForStatus } from './containers.mjs';
import { WizardSession } from './wizard.mjs';

const basicAuth = () =>
  `Basic ${Buffer.from(`${config.admin.username}:${config.admin.password}`).toString('base64')}`;

// Walks the setup wizard (Confluence 9.2). License and database steps are
// skipped by ATL_LICENSE_KEY / ATL_JDBC_* env vars on the container.
async function runSetupWizard() {
  const s = new WizardSession(baseUrl);
  await s.request('/');
  for (let step = 0; step < 12; step++) {
    const p = s.path;
    log(`Setup wizard: ${p}`);
    if (p.includes('setupcluster')) {
      await s.submit('clusterform', { newCluster: 'skipCluster' });
    } else if (p.includes('setuplicense')) {
      throw new Error('Setup wizard asked for a license; ATL_LICENSE_KEY was not applied. Run `testenv reset`.');
    } else if (p.includes('setupdata')) {
      await s.submit('blankChoiceForm');
    } else if (p.includes('setupusermanagementchoice')) {
      await s.submit('internaluser');
    } else if (p.includes('setupadministrator')) {
      const { username, fullName, email, password } = config.admin;
      await s.submit('setupadministratorform', { username, fullName, email, password, confirm: password });
    } else if (p.includes('finishsetup') || !p.startsWith('/setup')) {
      return;
    } else {
      throw new Error(`Unrecognised setup step ${p}. Errors: ${s.errors().join('; ')}`);
    }
    const errs = s.errors();
    if (errs.length) log(`  page messages: ${errs.join('; ')}`);
  }
  throw new Error('Setup wizard did not finish');
}

async function tokenWorks(token) {
  const res = await fetch(`${baseUrl}/rest/api/user/current`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return false;
  const user = await res.json();
  return user.type === 'known';
}

async function createToken() {
  const res = await fetch(`${baseUrl}/rest/pat/latest/tokens`, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `confluence-explorer-dev-${Date.now()}`, expirationDuration: 365 }),
  });
  if (!res.ok) throw new Error(`Creating PAT failed: ${res.status} ${await res.text()}`);
  return (await res.json()).rawToken;
}

export async function licenseDetails(token) {
  const res = await fetch(`${baseUrl}/rest/license/1.0/license/details`, {
    headers: { Authorization: token ? `Bearer ${token}` : basicAuth() },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function provision() {
  let state = await waitForStatus();
  if (state === 'FIRST_RUN') {
    await runSetupWizard();
    state = await waitForStatus(['RUNNING']);
  }

  let creds = readCredentials();
  if (!creds?.token || creds.baseUrl !== baseUrl || !(await tokenWorks(creds.token))) {
    log('Creating Personal Access Token for the admin user');
    creds = { baseUrl, username: config.admin.username, token: await createToken() };
    if (!(await tokenWorks(creds.token))) throw new Error('Newly created PAT was rejected');
    writeCredentials(creds);
  }

  const lic = await licenseDetails(creds.token);
  if (lic) log(`License: ${lic.expired ? 'EXPIRED' : 'valid'} until ${new Date(lic.expiryDate).toLocaleTimeString()}`);
  return creds;
}

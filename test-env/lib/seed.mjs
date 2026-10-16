import fs from 'node:fs';
import path from 'node:path';
import { baseUrl, DATA_DIR, log, STATE_DIR } from './config.mjs';
import { spaces, ignoreFiles, expectations } from '../fixtures/dataset.mjs';

export const MANIFEST_FILE = path.join(STATE_DIR, 'seed-manifest.json');

function client(token) {
  return async function api(method, urlPath, body) {
    const isForm = body instanceof FormData;
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
        ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${urlPath} -> ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  };
}

async function listPages(api, spaceKey) {
  const byTitle = new Map();
  for (let start = 0; ; start += 200) {
    const data = await api('GET', `/rest/api/content?spaceKey=${spaceKey}&type=page&limit=200&start=${start}`);
    for (const p of data.results || []) byTitle.set(p.title, p.id);
    if (!data._links?.next) break;
  }
  return byTitle;
}

async function ensureAttachments(api, pageId, attachments, counters) {
  if (!attachments?.length) return;
  const existing = await api('GET', `/rest/api/content/${pageId}/child/attachment?limit=100`);
  const have = new Set((existing.results || []).map((a) => a.title));
  for (const a of attachments) {
    if (have.has(a.filename)) continue;
    const form = new FormData();
    form.append('file', new Blob([a.content], { type: a.type }), a.filename);
    form.append('minorEdit', 'true');
    await api('POST', `/rest/api/content/${pageId}/child/attachment`, form);
    counters.attachments++;
  }
}

export async function seed(token) {
  const api = client(token);
  const me = await api('GET', '/rest/api/user/current');
  const ctx = { userKey: me.userKey };
  const counters = { spaces: 0, pages: 0, attachments: 0, existing: 0 };
  const manifest = { baseUrl, generatedAt: new Date().toISOString(), spaces: {} };

  for (const space of spaces) {
    let spaceInfo;
    try {
      spaceInfo = await api('GET', `/rest/api/space/${space.key}?expand=homepage`);
    } catch (e) {
      if (e.status !== 404) throw e;
      log(`Creating space ${space.key} (${space.name})`);
      await api('POST', '/rest/api/space', {
        key: space.key,
        name: space.name,
        description: { plain: { value: space.description, representation: 'plain' } },
      });
      spaceInfo = await api('GET', `/rest/api/space/${space.key}?expand=homepage`);
      const home = await api('GET', `/rest/api/content/${spaceInfo.homepage.id}?expand=version`);
      await api('PUT', `/rest/api/content/${home.id}`, {
        type: 'page',
        title: home.title,
        version: { number: home.version.number + 1 },
        body: { storage: { value: space.home, representation: 'storage' } },
      });
      counters.spaces++;
    }

    const homeId = spaceInfo.homepage.id;
    const byTitle = await listPages(api, space.key);
    const pages = {};
    const homeTitle = [...byTitle].find(([, id]) => id === homeId)?.[0] || `${space.name} Home`;
    pages[homeTitle] = { id: homeId, parent: null, depth: 0 };

    const walk = async (nodes, parentId, parentTitle, depth) => {
      for (const node of nodes) {
        let id = byTitle.get(node.title);
        if (id) {
          counters.existing++;
        } else {
          const body = typeof node.body === 'function' ? node.body(ctx) : node.body || '';
          const page = await api('POST', '/rest/api/content', {
            type: 'page',
            title: node.title,
            space: { key: space.key },
            ancestors: [{ id: parentId }],
            body: { storage: { value: body, representation: 'storage' } },
          });
          id = page.id;
          byTitle.set(node.title, id);
          counters.pages++;
          if (node.labels?.length) {
            await api('POST', `/rest/api/content/${id}/label`, node.labels.map((name) => ({ prefix: 'global', name })));
          }
        }
        await ensureAttachments(api, id, node.attachments, counters);
        pages[node.title] = { id, parent: parentTitle, depth };
        if (node.children) await walk(node.children, id, node.title, depth + 1);
      }
    };
    await walk(space.pages, homeId, homeTitle, 1);

    manifest.spaces[space.key] = { name: space.name, homeId, homeTitle, pages, expectations: expectations[space.key] };
    writeIgnoreFile(space.key, pages);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  log(
    `Seed complete: ${counters.pages} pages created, ${counters.existing} already present, ` +
      `${counters.attachments} attachments uploaded, ${counters.spaces} spaces created`
  );
  return manifest;
}

// The fixture is the source of truth: rewritten on every seed.
function writeIgnoreFile(spaceKey, pages) {
  const lines = (ignoreFiles[spaceKey] || []).map((line) =>
    line.replace(/\{\{id:([^}]+)\}\}/g, (_, title) => {
      const p = pages[title];
      if (!p) throw new Error(`.confluenceignore fixture for ${spaceKey} references unknown page "${title}"`);
      return p.id;
    })
  );
  const dir = path.join(DATA_DIR, 'spaces', spaceKey.toUpperCase());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.confluenceignore'),
    `# Generated by test-env seed from test-env/fixtures/dataset.mjs - edits are overwritten.\n${lines.join('\n')}\n`
  );
}

// Proof that Frontier's Host reads this repository's files: the Host's own
// Registry reader (containers/host/modules/registry), built by its own
// container, pointed at the files over file:// and over HTTP.
//
//   bash pipeline/proof/host-reads.sh <Frontier checkout>
//
// It reads the Registry exactly as this repository ships it, empty of
// listings with an empty blocklist, and then a Registry the pipeline wrote:
// a listed Application with two Releases, an unpublished one, a refusal's
// check and a blocklist entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const FRONTIER = process.env.FRONTIER ?? '';
assert.ok(FRONTIER !== '' && existsSync(join(FRONTIER, 'containers/host/modules/registry/interface.ts')), 'FRONTIER names a Frontier checkout');
const REGISTRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { container } = await import(join(FRONTIER, 'containers/host/container'));
const { inputs } = await import(join(FRONTIER, 'containers/host/inputs'));
const { Boundary: FilesSites } = await import(join(FRONTIER, 'modules/typescript/nodejs_files/boundary'));
const { Boundary: Network } = await import(join(FRONTIER, 'modules/typescript/nodejs_network_access/boundary'));
const { recordVerdict } = await import(join(REGISTRY_ROOT, 'pipeline/lib/record.mjs'));

const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);
const GONE = 'c'.repeat(40);
const REFUSED = 'd'.repeat(40);
const notes = (more: object) => ({ id: 'github.com/acme/notes', title: 'Notes', color: '#3b82f6', description: 'Markdown notes on every surface.', ...more });

function shipped(): string {
  const root = mkdtempSync(join(tmpdir(), 'registry-shipped-'));
  for (const file of ['index.json', 'blocklist.json', 'platform.json']) cpSync(join(REGISTRY_ROOT, file), join(root, file));
  return root;
}

function written(): string {
  const root = shipped();
  writeFileSync(join(root, 'platform.json'), JSON.stringify({ builds: [{ buildId: 'build-a', publishedAt: '2026-11-01T00:00:00.000Z' }] }));
  const listed = (id: string, commit: string, contributions: object, flags: string[] = []) => ({ outcome: 'listed', id, repository: `git@github.com:${id.slice('github.com/'.length)}.git`, cloneUrl: `https://${id}`, commit, flags, contributions });
  recordVerdict(root, listed('github.com/acme/notes', FIRST, notes({ host: { methods: [{ id: 'list-notes', title: 'List', description: 'Lists.' }] } })), '2026-11-19T10:00:00.000Z');
  recordVerdict(root, listed('github.com/acme/notes', SECOND, notes({ dependencies: [{ id: 'github.com/acme/speech', reason: 'dictation' }], host: { methods: [{ id: 'list-notes', title: 'List', description: 'Lists.' }] } }), ['reaches the network']), '2026-11-19T11:00:00.000Z');
  recordVerdict(root, listed('github.com/acme/gone', GONE, { id: 'github.com/acme/gone', title: 'Gone', color: '#111111' }), '2026-11-19T09:00:00.000Z');
  recordVerdict(root, { outcome: 'unpublished', id: 'github.com/acme/gone' }, '2026-11-19T12:00:00.000Z');
  recordVerdict(root, { outcome: 'rejected', id: 'github.com/acme/notes', repository: 'git@github.com:acme/notes.git', commit: REFUSED, reason: 'it does not build' }, '2026-11-19T13:00:00.000Z');
  writeFileSync(join(root, 'blocklist.json'), JSON.stringify({ applications: [], releases: [{ id: 'github.com/acme/notes', hash: FIRST, reason: 'leaked a token' }], publishers: [{ publisher: 'github.com/evil', reason: 'publishes malware' }] }, null, 2));
  return root;
}

async function served(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)).replace(/^\/+/, '');
    const full = join(root, path);
    if (path.includes('..') || !existsSync(full)) { response.writeHead(404).end('404: Not Found'); return; }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(readFileSync(full));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

type Crossing = { crossForReal: (...sites: unknown[]) => void; begin: () => unknown };

const readers = async (registry: string, read: (reader: any, context: unknown) => Promise<void>): Promise<void> => {
  await container.test('registry', { ...inputs, registry })(async (reader: unknown, boundary: Crossing) => {
    if (registry.startsWith('file://')) boundary.crossForReal(FilesSites.read);
    else boundary.crossForReal(Network.fetch, Network.readBody);
    await read(reader, boundary.begin());
  });
};

for (const [over, at] of [['file://', async (root: string) => ({ url: `file://${root}`, close: async () => {} })], ['HTTP', served]] as const) {
  test(`over ${over}, the Registry as this repository ships it reads as empty, its blocklist read and empty`, async () => {
    const place = await at(shipped());
    try {
      await readers(place.url, async (registry, context) => {
        assert.deepEqual(await registry.readIndex(context, { filter: '' }), { kind: 'read', index: [] });
        assert.deepEqual(await registry.readBlocklist(context, {}), { blocklist: { applications: [], releases: [], publishers: [] }, blocklistRead: true, reason: '', published: true });
        assert.deepEqual(await registry.readPlatformBuilds(context, {}), { kind: 'read', builds: [] });
        assert.deepEqual(await registry.readListing(context, { applicationId: 'github.com/frontierengineer/chat' }), { kind: 'unlisted' });
        assert.deepEqual(await registry.readCheck(context, { repository: 'https://github.com/acme/notes', commitHash: FIRST }), { kind: 'unchecked' });
      });
    } finally {
      await place.close();
    }
  });

  test(`over ${over}, a Registry the pipeline wrote reads in every shape the Host expects`, async () => {
    const place = await at(written());
    try {
      await readers(place.url, async (registry, context) => {
        const index = await registry.readIndex(context, { filter: 'markdown' });
        assert.equal(index.kind, 'read');
        assert.deepEqual(index.index.map(({ id, repository, title, description, color, latest }: any) => [id, repository, title, description, color, latest.hash, latest.listedAt, latest.flags, latest.platformBuild]),
          [['github.com/acme/notes', 'https://github.com/acme/notes', 'Notes', 'Markdown notes on every surface.', '#3b82f6', SECOND, '2026-11-19T11:00:00.000Z', ['reaches the network'], 'build-a']]);
        const listing = await registry.readListing(context, { applicationId: 'github.com/acme/notes' });
        assert.equal(listing.kind, 'listed');
        assert.deepEqual(listing.listing.releases.map(({ hash }: any) => hash), [FIRST, SECOND]);
        assert.deepEqual(await registry.readListing(context, { applicationId: 'github.com/acme/gone' }), { kind: 'unlisted' });
        const gone = await registry.readReleases(context, { applicationId: 'github.com/acme/gone' });
        assert.deepEqual(gone.kind === 'read' ? gone.releases.map(({ hash }: any) => hash) : gone, [GONE]);
        const tree = await registry.readTree(context, { applicationId: 'github.com/acme/notes' });
        assert.deepEqual(tree.tree.map(({ id, dependencyOf, reason, listed }: any) => [id, dependencyOf, reason, listed]),
          [['github.com/acme/notes', '', '', true], ['github.com/acme/speech', 'github.com/acme/notes', 'dictation', false]]);
        const reaches = await registry.readTreeContributions(context, { tree: tree.tree });
        assert.deepEqual(reaches.reaches[0].contributions.host, { methods: [{ id: 'list-notes', title: 'List', description: 'Lists.' }] });
        const blocklist = await registry.readBlocklist(context, {});
        assert.equal(blocklist.blocklistRead, true);
        assert.deepEqual(blocklist.blocklist.releases, [{ id: 'github.com/acme/notes', hash: FIRST, reason: 'leaked a token' }]);
        assert.deepEqual(await registry.readCheck(context, { repository: 'git@github.com:acme/notes.git', commitHash: SECOND }),
          { kind: 'checked', check: { repository: 'git@github.com:acme/notes.git', commitHash: SECOND, outcome: 'listed', reason: '', checkedAt: '2026-11-19T11:00:00.000Z' } });
        assert.deepEqual(await registry.readCheck(context, { repository: 'git@github.com:acme/notes.git', commitHash: REFUSED }),
          { kind: 'checked', check: { repository: 'git@github.com:acme/notes.git', commitHash: REFUSED, outcome: 'rejected', reason: 'it does not build', checkedAt: '2026-11-19T13:00:00.000Z' } });
        assert.deepEqual(await registry.readPlatformBuilds(context, {}), { kind: 'read', builds: [{ buildId: 'build-a', publishedAt: '2026-11-01T00:00:00.000Z' }] });
      });
    } finally {
      await place.close();
    }
  });
}

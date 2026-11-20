// Proof that Frontier's Host reads this repository's files: the Host's own
// Registry reader (containers/host/modules/registry), built by its own
// container, pointed at the files over file:// and over HTTP.
//
//   bash pipeline/proof/host-reads.sh <Frontier checkout>
//
// It reads the Registry exactly as this repository ships it, every listed
// Application in the index Browse shows and in its own file, and then a
// Registry the pipeline wrote: a listed Application with two Releases, an
// unpublished one, a refusal's check and a blocklist entry. Over HTTP the
// files are served with an ETag, as raw.githubusercontent.com serves them,
// and a file asked for again with it is answered 304.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const { Boundary: Clock } = await import(join(FRONTIER, 'modules/typescript/nodejs_clock_and_timers/boundary'));
const { recordVerdict } = await import(join(REGISTRY_ROOT, 'pipeline/lib/record.mjs'));

const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);
const GONE = 'c'.repeat(40);
const REFUSED = 'd'.repeat(40);
const notes = (more: object) => ({ id: 'github.com/acme/notes', title: 'Notes', color: '#3b82f6', description: 'Markdown notes on every surface.', ...more });

const readJson = (root: string, path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

function shipped(): string {
  const root = mkdtempSync(join(tmpdir(), 'registry-shipped-'));
  for (const file of ['index.json', 'blocklist.json', 'platform.json', 'applications', 'checks']) cpSync(join(REGISTRY_ROOT, file), join(root, file), { recursive: true });
  return root;
}

function written(): string {
  const root = mkdtempSync(join(tmpdir(), 'registry-written-'));
  for (const file of ['index.json', 'blocklist.json', 'platform.json']) cpSync(join(REGISTRY_ROOT, file), join(root, file));
  writeFileSync(join(root, 'platform.json'), JSON.stringify({ builds: [{ buildId: 'build-a', publishedAt: '2026-11-01T00:00:00.000Z' }] }));
  const listed = (id: string, commit: string, contributions: object, flags: string[] = []) => ({ outcome: 'listed', id, repository: `git@github.com:${id.slice('github.com/'.length)}.git`, cloneUrl: `https://${id}`, repositoryId: id.length, commit, flags, contributions });
  recordVerdict(root, listed('github.com/acme/notes', FIRST, notes({ host: { methods: [{ id: 'list-notes', title: 'List', description: 'Lists.' }] } })), '2026-11-19T10:00:00.000Z');
  recordVerdict(root, listed('github.com/acme/notes', SECOND, notes({ dependencies: [{ id: 'github.com/acme/speech', reason: 'dictation' }], host: { methods: [{ id: 'list-notes', title: 'List', description: 'Lists.' }] } }), ['network']), '2026-11-19T11:00:00.000Z');
  recordVerdict(root, listed('github.com/acme/gone', GONE, { id: 'github.com/acme/gone', title: 'Gone', color: '#111111' }), '2026-11-19T09:00:00.000Z');
  recordVerdict(root, { outcome: 'unpublished', id: 'github.com/acme/gone' }, '2026-11-19T12:00:00.000Z');
  recordVerdict(root, { outcome: 'rejected', id: 'github.com/acme/notes', repository: 'git@github.com:acme/notes.git', commit: REFUSED, reason: 'it does not build' }, '2026-11-19T13:00:00.000Z');
  writeFileSync(join(root, 'blocklist.json'), JSON.stringify({ applications: [], releases: [{ id: 'github.com/acme/notes', hash: FIRST, reason: 'leaked a token' }], publishers: [{ publisher: 'github.com/evil', reason: 'publishes malware' }] }, null, 2));
  return root;
}

type Place = { url: string; close: () => Promise<void>; unchanged: () => number };

/** Serves the files as raw.githubusercontent.com does: each with an ETag,
 *  and 304 with no body to a request naming the one it has now. */
async function served(root: string): Promise<Place> {
  let unchanged = 0;
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)).replace(/^\/+/, '');
    const full = join(root, path);
    if (path.includes('..') || !existsSync(full)) { response.writeHead(404).end('404: Not Found'); return; }
    const body = readFileSync(full);
    const tag = `"${createHash('sha256').update(body).digest('hex')}"`;
    if (request.headers['if-none-match'] === tag) { unchanged += 1; response.writeHead(304, { etag: tag }).end(); return; }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', etag: tag }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())), unchanged: () => unchanged };
}

const onDisk = async (root: string): Promise<Place> => ({ url: `file://${root}`, close: async () => {}, unchanged: () => 0 });

type Crossing = { crossForReal: (...sites: unknown[]) => void; begin: () => unknown; expectCall: (...args: unknown[]) => void };

const readers = async (registry: string, read: (reader: any, context: unknown, boundary: Crossing) => Promise<void>): Promise<void> => {
  await container.test('registry', { ...inputs, registry })(async (reader: unknown, boundary: Crossing) => {
    if (registry.startsWith('file://')) boundary.crossForReal(FilesSites.read);
    else boundary.crossForReal(Network.fetch, Network.readBody);
    await read(reader, boundary.begin(), boundary);
  });
};

for (const [over, at] of [['file://', onDisk], ['HTTP', served]] as const) {
  test(`over ${over}, the Registry as this repository ships it reads whole: the index holds only what Browse shows, and each Application's own file the rest`, async () => {
    const root = shipped();
    const published = readJson(root, 'index.json');
    assert.equal(published.report, 'https://github.com/frontierengineer/registry/issues/new?template=report-an-application.yml');
    for (const entry of published.applications) {
      assert.deepEqual(Object.keys(entry), ['id', 'title', 'description', 'color', 'latest'], `${entry.id}'s index entry holds only what Browse shows`);
      assert.deepEqual(Object.keys(entry.latest), ['hash', 'listedAt', 'flags'], `${entry.id}'s latest Release in the index carries no contributions`);
    }
    const place = await at(root);
    try {
      await readers(place.url, async (registry, context) => {
        assert.deepEqual(await registry.readIndex(context, { filter: '' }), { kind: 'read', index: published.applications });
        assert.deepEqual(await registry.readReport(context, {}), { kind: 'named', address: published.report });
        for (const entry of published.applications) {
          const file = readJson(root, `applications/${entry.id}.json`);
          const listing = await registry.readListing(context, { applicationId: entry.id });
          assert.equal(listing.kind, 'listed', entry.id);
          const latest = listing.listing.releases.at(-1);
          assert.deepEqual([latest.hash, latest.listedAt, latest.flags], [entry.latest.hash, entry.latest.listedAt, entry.latest.flags], `${entry.id}: the index's latest Release is its file's`);
          assert.deepEqual(latest.contributions, file.releases.at(-1).contributions, `${entry.id}: what it contributes is read from its own file`);
          assert.equal(latest.contributions.title, entry.title);
          const tree = await registry.readTree(context, { applicationId: entry.id });
          assert.equal(tree.kind, 'read', entry.id);
          assert.equal(tree.tree[0].release.hash, entry.latest.hash);
          assert.deepEqual(await registry.readCheck(context, { repository: readJson(root, `checks/${entry.latest.hash}.json`).repository, commitHash: entry.latest.hash }),
            { kind: 'checked', check: readJson(root, `checks/${entry.latest.hash}.json`) });
        }
        assert.deepEqual(await registry.readBlocklist(context, {}), { blocklist: { applications: [], releases: [], publishers: [] }, blocklistRead: true, reason: '', published: true });
        assert.deepEqual(await registry.readPlatformBuilds(context, {}), { kind: 'read', builds: [] });
        assert.deepEqual(await registry.readListing(context, { applicationId: 'github.com/acme/never' }), { kind: 'unlisted' });
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
        assert.deepEqual(index.index, [{ id: 'github.com/acme/notes', title: 'Notes', description: 'Markdown notes on every surface.', color: '#3b82f6', latest: { hash: SECOND, listedAt: '2026-11-19T11:00:00.000Z', flags: ['network'] } }]);
        const listing = await registry.readListing(context, { applicationId: 'github.com/acme/notes' });
        assert.equal(listing.kind, 'listed');
        assert.equal(listing.listing.repository, 'https://github.com/acme/notes');
        assert.deepEqual(listing.listing.releases.map(({ hash, platformBuild }: any) => [hash, platformBuild]), [[FIRST, 'build-a'], [SECOND, 'build-a']]);
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

test('over HTTP, a file read again after five minutes is asked for with its ETag, and answered 304 is the copy held', async () => {
  const place = await served(shipped());
  try {
    await readers(place.url, async (registry, context, boundary) => {
      const first = await registry.readIndex(context, { filter: '' });
      const id = first.index[0].id;
      const listing = await registry.readListing(context, { applicationId: id });
      assert.equal(place.unchanged(), 0);
      boundary.expectCall(Clock.now, () => true, () => '2001-01-01T00:00:00.000Z');
      assert.deepEqual(await registry.readIndex(context, { filter: '' }), first);
      boundary.expectCall(Clock.now, () => true, () => '2001-01-01T00:00:00.000Z');
      assert.deepEqual(await registry.readListing(context, { applicationId: id }), listing);
      assert.equal(place.unchanged(), 2, 'the index and the listing were each answered 304');
    });
  } finally {
    await place.close();
  }
});

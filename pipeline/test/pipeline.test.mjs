import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { breakingChanges } from '../lib/breaking.mjs';
import { backfillSources, filesOfArchive, sourceDigestOf, sourceSha256Of } from '../lib/source.mjs';
import { checkListing } from '../lib/check.mjs';
import { listingChangeOf } from '../lib/listing.mjs';
import { identityOfRepository } from '../lib/identity.mjs';
import { recordVerdict } from '../lib/record.mjs';
import { flagsOf, packagesProblem, secretIn } from '../lib/scan.mjs';
import { squattedOn } from '../lib/typosquat.mjs';
import { contributionsText, emptyRegistry, fakeGitHub, repositories } from './fixtures.mjs';

const NOTES = 'github.com/acme/notes';
const REPORT = 'https://github.com/frontierengineer/registry/issues/new?template=report-an-application.yml';
const read = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const listingText = (id, repository, commit) => `${JSON.stringify({ id, repository, commit }, null, 2)}\n`;
const added = (id) => [{ status: 'A', path: `listings/${id}.json` }];
const replaced = (id) => [{ status: 'M', path: `listings/${id}.json` }];

const EMPTY_PACKAGE = '{ "name": "notes", "version": "1.0.0", "private": true }\n';
const EMPTY_LOCK = `${JSON.stringify({ name: 'notes', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'notes', version: '1.0.0' } } }, null, 2)}\n`;
const HOST = `import type { HostRegistration } from './application';\nexport const registration = { methods: { 'list-notes': { async call() { const answer = await fetch('https://example.invalid'); return { status: answer.status }; } } } } satisfies HostRegistration;\n`;
const HOST_TYPES = 'export interface HostRegistration { methods?: Record<string, { call(...args: unknown[]): unknown }> }\n';
const notesFiles = (more = {}) => ({
  'contributions.json': contributionsText(NOTES, { host: { methods: [{ id: 'list-notes', title: 'List notes', description: 'Lists the notes.' }] }, surface: { actions: [{ id: 'create-note', title: 'Create note', description: 'Creates a note.', input: [{ type: 'text', key: 'title', label: 'Title' }] }] } }),
  'host.ts': HOST,
  'application.d.ts': HOST_TYPES,
  'package.json': EMPTY_PACKAGE,
  'package-lock.json': EMPTY_LOCK,
  ...more,
});

test('the repository forms a publisher gives yield the id the Host gives', () => {
  assert.equal(identityOfRepository('https://github.com/acme/notes'), NOTES);
  assert.equal(identityOfRepository('https://github.com/acme/notes.git/'), NOTES);
  assert.equal(identityOfRepository('git@github.com:acme/notes.git'), NOTES);
  assert.equal(identityOfRepository('ssh://git@github.com/acme/notes'), NOTES);
  assert.equal(identityOfRepository('notes'), null);
});

test('a listing pull request changes exactly one listing file', () => {
  assert.deepEqual(listingChangeOf(added(NOTES)), { kind: 'list', id: NOTES, path: `listings/${NOTES}.json` });
  assert.deepEqual(listingChangeOf([{ status: 'D', path: `listings/${NOTES}.json` }]), { kind: 'unpublish', id: NOTES, path: `listings/${NOTES}.json` });
  assert.match(listingChangeOf([{ status: 'M', path: 'blocklist.json' }]).problem, /changes only listings/);
  assert.match(listingChangeOf([...added(NOTES), { status: 'A', path: 'index.json' }]).problem, /changes 2/);
  assert.match(listingChangeOf([{ status: 'R', path: `listings/${NOTES}.json` }]).problem, /renamed/);
});

test('a name within typosquatting distance of another owner\'s is refused, and an owner\'s own names never are', () => {
  assert.equal(squattedOn('github.com/acrne/notes', [NOTES]), NOTES);
  assert.equal(squattedOn('github.com/acme0/notes', [NOTES]), NOTES);
  assert.equal(squattedOn('github.com/acme/notes', ['github.com/acme-/notes']), 'github.com/acme-/notes');
  assert.equal(squattedOn('github.com/amce/notes', [NOTES]), NOTES);
  assert.equal(squattedOn('github.com/acme/note', [NOTES]), null);
  assert.equal(squattedOn('github.com/other/notes', [NOTES]), null);
});

test('a later Release only adds to what was published', () => {
  const before = { surface: { actions: [{ id: 'a', input: [{ key: 'k', type: 'text' }] }] }, host: { methods: [{ id: 'm' }], notifier: { title: 'n' } } };
  assert.deepEqual(breakingChanges(before, { ...before, host: { ...before.host, methods: [{ id: 'm' }, { id: 'n' }] } }), []);
  assert.deepEqual(breakingChanges(before, { ...before, surface: { actions: [{ id: 'a', input: [{ key: 'k', type: 'text' }, { key: 'o', type: 'number' }] }] } }), []);
  assert.deepEqual(breakingChanges(before, { surface: before.surface, host: { methods: [{ id: 'renamed' }] } }), ['it removes its notifier', 'it removes the method "m"']);
  assert.deepEqual(breakingChanges(before, { ...before, surface: { actions: [{ id: 'a', input: [{ key: 'k', type: 'number' }] }] } }), ['the action "a" changes the field "k" from text to number']);
  assert.deepEqual(breakingChanges(before, { ...before, surface: { actions: [{ id: 'a', input: [{ key: 'k', type: 'text', required: true }, { key: 'r', type: 'text', required: true }] }] } }),
    ['the action "a" makes the field "k" required', 'the action "a" adds the required field "r"']);
  const typed = { host: { methods: [{ id: 'm', input: [{ key: 'q', type: 'text' }], output: [{ key: 'n', type: 'number', required: true }] }] } };
  assert.deepEqual(breakingChanges(typed, { host: { methods: [{ id: 'm', input: [{ key: 'q', type: 'text' }], output: [{ key: 'n', type: 'number', required: true }, { key: 'more', type: 'text' }] }] } }), []);
  assert.deepEqual(breakingChanges(typed, { host: { methods: [{ id: 'm', input: [{ key: 'q', type: 'number' }], output: [{ key: 'n', type: 'number' }] }] } }),
    ['the method "m" changes the field "q" from text to number', 'the method "m" no longer always answers the field "n"']);
});

test('the scan refuses secrets and packages from outside npm, and flags what the Bundles reach', () => {
  assert.equal(secretIn([{ path: 'a.ts', text: 'const ok = 1;' }]), null);
  assert.equal(secretIn([{ path: 'id_rsa', text: '-----BEGIN OPENSSH PRIVATE KEY-----\n' }]), 'a private key in id_rsa');
  assert.equal(secretIn([{ path: '.env', text: `TOKEN=ghp_${'a'.repeat(36)}` }]), 'a GitHub token in .env');
  assert.equal(packagesProblem(null, null), null);
  assert.match(packagesProblem('{}', null), /without package-lock.json/);
  const lock = (resolved) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/left-pad': { version: '1.3.0', resolved, integrity: 'sha512-x' } } });
  assert.equal(packagesProblem('{}', lock('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz')), null);
  assert.match(packagesProblem('{}', lock('git+ssh://git@github.com/x/left-pad.git')), /left-pad is not from the npm registry/);
  assert.deepEqual(flagsOf(['import { spawn } from "node:child_process"; fetch(url); eval(text);']), ['network', 'processes', 'dynamic code']);
  assert.deepEqual(flagsOf(['export const registration = {};']), []);
});

test('dry run: a listing pull request is checked, listed, replaced, refused and unpublished, and the files come out as the Host reads them', async () => {
  const root = emptyRegistry();
  const repos = repositories();
  const known = {
    repositories: { 'acme/notes': { owner: 'acme', type: 'Organization' }, 'acrne/notes': { owner: 'acrne' }, 'acme/secret': { owner: 'acme', type: 'Organization', private: true } },
    members: { acme: ['ada'] },
  };
  const github = fakeGitHub(known);
  const check = (changes, text, author = 'ada') => checkListing({ root, changes, listingText: text, author, github, cloneUrlFor: repos.cloneUrlFor, archiveFor: repos.archiveFor });

  const first = repos.commit('acme', 'notes', notesFiles());
  const listed = await check(added(NOTES), listingText(NOTES, 'git@github.com:acme/notes.git', first));
  assert.equal(listed.outcome, 'listed', listed.reason);
  assert.deepEqual(listed.flags, ['network']);
  assert.equal(listed.cloneUrl, 'https://github.com/acme/notes');
  const served = await repos.archiveFor(`https://codeload.github.com/acme/notes/tar.gz/${first}`);
  assert.equal(listed.sourceSha256, sourceDigestOf(filesOfArchive(served.bytes).files), 'the verdict pins the files of the archive GitHub serves for the commit');
  assert.deepEqual(recordVerdict(root, listed, '2026-11-19T10:00:00.000Z'), [`applications/${NOTES}.json`, `checks/${first}.json`, 'index.json']);
  const file = read(root, `applications/${NOTES}.json`);
  assert.deepEqual(Object.keys(file), ['id', 'repository', 'repositoryId', 'unpublished', 'releases']);
  assert.equal(file.repositoryId, 1000);
  assert.deepEqual(file.releases.map(({ hash, sourceSha256, listedAt, flags, platformBuild }) => ({ hash, sourceSha256, listedAt, flags, platformBuild })), [{ hash: first, sourceSha256: listed.sourceSha256, listedAt: '2026-11-19T10:00:00.000Z', flags: ['network'], platformBuild: '' }]);
  assert.deepEqual(Object.keys(file.releases[0]), ['hash', 'sourceSha256', 'listedAt', 'flags', 'platformBuild', 'contributions']);
  assert.equal(file.releases[0].contributions.title, 'Notes');
  assert.deepEqual(read(root, `checks/${first}.json`), { repository: 'git@github.com:acme/notes.git', commitHash: first, outcome: 'listed', reason: '', checkedAt: '2026-11-19T10:00:00.000Z' });
  assert.equal(read(root, 'index.json').report, REPORT, 'rebuilding the index keeps where an Application is reported');
  assert.deepEqual(read(root, 'index.json').applications,
    [{ id: NOTES, title: 'Notes', description: 'Markdown notes on every surface.', color: '#3b82f6', latest: { hash: first, listedAt: '2026-11-19T10:00:00.000Z', flags: ['network'] } }],
    'the index holds only what Browse shows: no repository, no Platform build and no contributions, which stay in the Application file');

  const refused = async (changes, text, pattern, author) => {
    const verdict = await check(changes, text, author);
    assert.equal(verdict.outcome, 'rejected', `expected a refusal matching ${pattern}`);
    assert.match(verdict.reason, pattern);
    return verdict;
  };
  await refused(added(NOTES), listingText(NOTES, 'https://github.com/acme/notes', first), /already a Release/);
  await refused(added(NOTES), listingText(NOTES, 'https://github.com/acme/notes', first), /owns acme\/notes/, 'mallory');
  await refused(added('github.com/acme/other'), listingText('github.com/acme/other', 'https://github.com/acme/notes', first), /gives github.com\/acme\/notes, not github.com\/acme\/other/);
  await refused(added(NOTES), `${JSON.stringify({ id: NOTES, repository: 'https://github.com/acme/notes', commit: first, title: 'x' })}`, /only id, repository and commit/);
  await refused(added(NOTES), listingText(NOTES, 'https://github.com/acme/notes', first.slice(0, 12)), /not a full commit hash/);
  await refused(added('github.com/acme/secret'), listingText('github.com/acme/secret', 'https://github.com/acme/secret', first), /is private/);
  await refused(added('github.com/acrne/notes'), listingText('github.com/acrne/notes', 'https://github.com/acrne/notes', first), /typosquatting distance of github.com\/acme\/notes/, 'acrne');
  await refused(added(NOTES), listingText(NOTES, 'https://github.com/acme/notes', repos.dangling('acme', 'notes')), /not on any branch or tag/);

  known.repositories['acme/notes'].repositoryId = 2000;
  const takeover = repos.commit('acme', 'notes', notesFiles({ 'README.md': 'new owner\n' }));
  await refused(replaced(NOTES), listingText(NOTES, 'https://github.com/acme/notes', takeover), /a different GitHub repository from the one the Registry listed under that id \(repository 1000, now 2000\)/);
  await refused([{ status: 'D', path: `listings/${NOTES}.json` }], null, /a different GitHub repository/);
  delete known.repositories['acme/notes'].repositoryId;

  const renamed = repos.commit('acme', 'notes', { 'contributions.json': contributionsText(NOTES, { host: { methods: [{ id: 'notes', title: 'List', description: 'Lists.' }] } }) });
  await refused(replaced(NOTES), listingText(NOTES, 'https://github.com/acme/notes', renamed), /removes the method "list-notes"/);
  const wrongId = repos.commit('acme', 'notes', { 'contributions.json': contributionsText('github.com/acme/elsewhere') });
  await refused(replaced(NOTES), listingText(NOTES, 'https://github.com/acme/notes', wrongId), /declares the id github.com\/acme\/elsewhere/);
  const leaked = repos.commit('acme', 'notes', { ...notesFiles(), '.env': `ANTHROPIC_API_KEY=sk-ant-${'x'.repeat(40)}\n` });
  await refused(replaced(NOTES), listingText(NOTES, 'https://github.com/acme/notes', leaked), /an Anthropic API key in \.env/);
  const unlocked = repos.commit('acme', 'notes', { ...notesFiles(), '.env': null, 'package-lock.json': null });
  await refused(replaced(NOTES), listingText(NOTES, 'https://github.com/acme/notes', unlocked), /without package-lock.json/);
  const broken = repos.commit('acme', 'notes', { ...notesFiles(), 'host.ts': "import { gone } from './nowhere';\nexport const registration = { gone };\n" });
  const unbuilt = await refused(replaced(NOTES), listingText(NOTES, 'https://github.com/acme/notes', broken), /does not build: host.ts: .*Could not resolve "\.\/nowhere"/);
  assert.deepEqual(recordVerdict(root, unbuilt, '2026-11-19T10:05:00.000Z'), [`checks/${broken}.json`]);
  assert.deepEqual(read(root, `checks/${broken}.json`).outcome, 'rejected');

  const second = repos.commit('acme', 'notes', notesFiles({ 'host.ts': HOST.replace("'list-notes'", "'list-notes': { async call() { return {}; } }, 'count-notes'"), 'contributions.json': contributionsText(NOTES, { host: { methods: [{ id: 'list-notes', title: 'List notes', description: 'Lists the notes.' }, { id: 'count-notes', title: 'Count', description: 'Counts.' }] }, surface: { actions: [{ id: 'create-note', title: 'Create note', description: 'Creates a note.', input: [{ type: 'text', key: 'title', label: 'Title' }] }] } }) }));
  const update = await check(replaced(NOTES), listingText(NOTES, 'https://github.com/acme/notes', second));
  assert.equal(update.outcome, 'listed', update.reason);
  recordVerdict(root, update, '2026-11-19T11:00:00.000Z');
  assert.deepEqual(read(root, `applications/${NOTES}.json`).releases.map(({ hash }) => hash), [first, second]);
  assert.equal(read(root, 'index.json').applications[0].latest.hash, second);

  await refused([{ status: 'D', path: `listings/${NOTES}.json` }], null, /owns acme\/notes/, 'mallory');
  const gone = await check([{ status: 'D', path: `listings/${NOTES}.json` }], null);
  assert.deepEqual(gone, { outcome: 'unpublished', id: NOTES });
  recordVerdict(root, gone, '2026-11-19T12:00:00.000Z');
  assert.equal(read(root, `applications/${NOTES}.json`).unpublished, true);
  assert.deepEqual(read(root, `applications/${NOTES}.json`).releases.map(({ hash }) => hash), [first, second]);
  assert.deepEqual(read(root, 'index.json'), { report: REPORT, applications: [] });

  const back = await check(added(NOTES), listingText(NOTES, 'https://github.com/acme/notes', second));
  assert.equal(back.outcome, 'listed', back.reason);
  recordVerdict(root, back, '2026-11-19T13:00:00.000Z');
  assert.equal(read(root, `applications/${NOTES}.json`).unpublished, false);
  assert.deepEqual(read(root, `applications/${NOTES}.json`).releases.map(({ hash, listedAt }) => [hash, listedAt]), [[first, '2026-11-19T10:00:00.000Z'], [second, '2026-11-19T11:00:00.000Z']]);
  assert.equal(existsSync(join(root, 'listings')), true);
});

const SOURCE_DIGEST_VECTOR = {
  files: [
    { path: 'contributions.json', executable: false, text: '{ "id": "github.com/acme/vector", "title": "Vector", "color": "#000000" }\n' },
    { path: 'bin/run.sh', executable: true, text: '#!/bin/sh\necho hi\n' },
    { path: 'src/a b.ts', executable: false, text: '' },
    { path: 'src/ünïcode.ts', executable: false, text: 'export const word = "über";\n' },
    { path: 'Z.md', executable: false, text: '# Z\n' },
    { path: 'src/lib/deep.ts', executable: false, text: 'export {};\n' },
  ],
  sourceSha256: 'e93a7326ac66c721a17d3e80f965296d7fd7650940433092205286afe73f1431',
};

const tarred = (build) => {
  const place = mkdtempSync(join(tmpdir(), 'registry-source-'));
  try {
    build(join(place, 'vector-abc'));
    const ran = spawnSync('tar', ['-czf', '-', '-C', place, 'vector-abc']);
    assert.equal(ran.status, 0, String(ran.stderr));
    return new Uint8Array(ran.stdout);
  } finally {
    rmSync(place, { recursive: true, force: true });
  }
};
const vectorTree = (root) => {
  for (const { path, executable, text } of SOURCE_DIGEST_VECTOR.files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    chmodSync(join(root, path), executable ? 0o755 : 0o644);
  }
};

test('the source digest of the shared test vector is the one Frontier\'s Host and build compute, from the files and from an archive of them however it is compressed', () => {
  const files = SOURCE_DIGEST_VECTOR.files.map(({ path, executable, text }) => ({ path, executable, bytes: Buffer.from(text, 'utf8') }));
  assert.equal(sourceDigestOf(files), SOURCE_DIGEST_VECTOR.sourceSha256);
  assert.equal(sourceDigestOf([...files].reverse()), SOURCE_DIGEST_VECTOR.sourceSha256);
  const archive = tarred(vectorTree);
  const again = gzipSync(gunzipSync(archive), { level: 1 });
  assert.notDeepEqual(createHash('sha256').update(again).digest('hex'), createHash('sha256').update(archive).digest('hex'));
  assert.equal(sourceDigestOf(filesOfArchive(archive).files), SOURCE_DIGEST_VECTOR.sourceSha256);
  assert.equal(sourceDigestOf(filesOfArchive(again).files), SOURCE_DIGEST_VECTOR.sourceSha256, 'compressed otherwise, the same files have the same digest');
  const changed = tarred((root) => { vectorTree(root); writeFileSync(join(root, 'Z.md'), '# Y\n'); });
  assert.notEqual(sourceDigestOf(filesOfArchive(changed).files), SOURCE_DIGEST_VECTOR.sourceSha256);
  const plain = tarred((root) => { vectorTree(root); chmodSync(join(root, 'bin/run.sh'), 0o644); });
  assert.notEqual(sourceDigestOf(filesOfArchive(plain).files), SOURCE_DIGEST_VECTOR.sourceSha256, 'a file no longer executable is another source');
  const linked = tarred((root) => { vectorTree(root); symlinkSync('/etc/passwd', join(root, 'secret')); });
  assert.match(filesOfArchive(linked).problem, /secret is a link, and Frontier installs no link/);
  assert.match(filesOfArchive(new TextEncoder().encode('not gzip')).problem, /^it is not gzipped/);
});

test('a source digest is recorded only from an archive that is served and that Frontier installs, and says why not', async () => {
  const commit = 'c'.repeat(40);
  const asked = [];
  const serving = (...answers) => async (url) => { asked.push(url); return answers.shift(); };
  const archive = tarred(vectorTree);
  assert.deepEqual(await sourceSha256Of(NOTES, commit, serving({ kind: 'downloaded', bytes: archive })), { sha256: SOURCE_DIGEST_VECTOR.sourceSha256 });
  assert.deepEqual(asked, [`https://codeload.github.com/acme/notes/tar.gz/${commit}`]);
  const failed = await sourceSha256Of(NOTES, commit, serving({ kind: 'failed', reason: 'it answered 404' }));
  assert.match(failed.problem, /cannot be downloaded: it answered 404/);
  assert.equal(failed.refused, false);
  const linked = await sourceSha256Of(NOTES, commit, serving({ kind: 'downloaded', bytes: tarred((root) => { vectorTree(root); symlinkSync('/etc/passwd', join(root, 'secret')); }) }));
  assert.match(linked.problem, /installs no link/);
  assert.equal(linked.refused, true);
  assert.match((await sourceSha256Of('gitlab.com/acme/notes', commit, serving())).problem, /not a GitHub repository/);
});

test('a listing whose archive cannot be downloaded is not listed and is tried again; one holding a link is refused', async () => {
  const root = emptyRegistry();
  const repos = repositories();
  const github = fakeGitHub({ repositories: { 'acme/notes': { owner: 'acme' } } });
  const commit = repos.commit('acme', 'notes', notesFiles());
  const check = (archiveFor) => checkListing({ root, changes: added(NOTES), listingText: listingText(NOTES, 'https://github.com/acme/notes', commit), author: 'acme', github, cloneUrlFor: repos.cloneUrlFor, archiveFor });
  const unavailable = await check(async () => ({ kind: 'failed', reason: 'codeload answered 503' }));
  assert.equal(unavailable.outcome, 'unavailable');
  assert.match(unavailable.reason, /codeload answered 503/);
  const linked = await check(async () => ({ kind: 'downloaded', bytes: tarred((at) => { vectorTree(at); symlinkSync('/etc/passwd', join(at, 'secret')); }) }));
  assert.equal(linked.outcome, 'rejected');
  assert.match(linked.reason, /installs no link/);
  assert.throws(() => recordVerdict(root, { outcome: 'listed', id: NOTES, repository: 'https://github.com/acme/notes', cloneUrl: 'https://github.com/acme/notes', repositoryId: 1, commit, flags: [], contributions: {} }, '2026-11-19T10:00:00.000Z'), /no source digest/);
});

test('backfilling records the source digest of every Release that lacks one, drops a pin of the archive\'s bytes, and records nothing twice', async () => {
  const root = emptyRegistry();
  const at = '2026-11-19T10:00:00.000Z';
  const one = 'a'.repeat(40);
  const two = 'b'.repeat(40);
  const older = { hash: one, archiveSha256: 'd'.repeat(64), listedAt: at, flags: [], platformBuild: '', contributions: { id: NOTES } };
  const pinned = 'f'.repeat(64);
  const path = `applications/${NOTES}.json`;
  mkdirSync(join(root, 'applications', 'github.com', 'acme'), { recursive: true });
  writeFileSync(join(root, path), `${JSON.stringify({ id: NOTES, repository: 'https://github.com/acme/notes', repositoryId: 1, unpublished: false, releases: [older, { ...older, hash: two, sourceSha256: pinned }] }, null, 2)}\n`);
  const asked = [];
  const archive = tarred(vectorTree);
  const archiveFor = async (url) => { asked.push(url); return { kind: 'downloaded', bytes: archive }; };
  const done = await backfillSources(root, archiveFor);
  assert.deepEqual(done, { recorded: [{ id: NOTES, hash: one, sourceSha256: SOURCE_DIGEST_VECTOR.sourceSha256 }], problems: [], written: [path] });
  assert.deepEqual(asked, [`https://codeload.github.com/acme/notes/tar.gz/${one}`], 'a Release with a digest already is not downloaded');
  const file = read(root, path);
  assert.deepEqual(file.releases.map((release) => [release.hash, release.sourceSha256]), [[one, SOURCE_DIGEST_VECTOR.sourceSha256], [two, pinned]]);
  assert.deepEqual(Object.keys(file.releases[0]), ['hash', 'sourceSha256', 'listedAt', 'flags', 'platformBuild', 'contributions']);
  assert.deepEqual(await backfillSources(root, archiveFor), { recorded: [], problems: [], written: [] });
  const failing = await backfillSources(root, async () => ({ kind: 'failed', reason: 'nope' }));
  assert.deepEqual(failing.problems, []);
});

test('the index holds only what Browse shows, however much a Release contributes, and keeps the fields a maintainer wrote', () => {
  const root = emptyRegistry();
  const at = '2026-11-19T10:00:00.000Z';
  const panels = Array.from({ length: 200 }, (_, n) => ({ id: `panel-${n}`, title: `Panel ${n}`, description: 'A panel that takes room in the Application file and none in the index.' }));
  const listed = (id, commit, contributions, flags = []) => ({ outcome: 'listed', id, repository: `https://${id}`, cloneUrl: `https://${id}`, repositoryId: id.length, commit, sourceSha256: 'e'.repeat(64), flags, contributions });
  recordVerdict(root, listed(NOTES, 'a'.repeat(40), { id: NOTES, title: 'Notes', description: 'Markdown notes.', color: '#3b82f6', surface: { panels } }, ['network']), at);
  recordVerdict(root, listed('github.com/acme/bare', 'b'.repeat(40), { id: 'github.com/acme/bare' }), at);
  const index = read(root, 'index.json');
  assert.deepEqual(Object.keys(index), ['report', 'applications']);
  assert.equal(index.report, REPORT);
  assert.deepEqual(index.applications, [
    { id: 'github.com/acme/bare', title: 'github.com/acme/bare', description: '', color: '', latest: { hash: 'b'.repeat(40), listedAt: at, flags: [] } },
    { id: NOTES, title: 'Notes', description: 'Markdown notes.', color: '#3b82f6', latest: { hash: 'a'.repeat(40), listedAt: at, flags: ['network'] } },
  ]);
  assert.deepEqual(read(root, `applications/${NOTES}.json`).releases[0].contributions.surface.panels, panels, 'the Application file keeps every contribution');
  assert.ok(readFileSync(join(root, 'index.json')).length < 1024, 'the index does not grow with what a Release contributes');
});

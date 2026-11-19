import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { breakingChanges } from '../lib/breaking.mjs';
import { checkListing, listingChangeOf } from '../lib/check.mjs';
import { identityOfRepository } from '../lib/identity.mjs';
import { recordVerdict } from '../lib/record.mjs';
import { flagsOf, packagesProblem, secretIn } from '../lib/scan.mjs';
import { squattedOn } from '../lib/typosquat.mjs';
import { contributionsText, emptyRegistry, fakeGitHub, repositories } from './fixtures.mjs';

const NOTES = 'github.com/acme/notes';
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
  const check = (changes, text, author = 'ada') => checkListing({ root, changes, listingText: text, author, github, cloneUrlFor: repos.cloneUrlFor });

  const first = repos.commit('acme', 'notes', notesFiles());
  const listed = await check(added(NOTES), listingText(NOTES, 'git@github.com:acme/notes.git', first));
  assert.equal(listed.outcome, 'listed', listed.reason);
  assert.deepEqual(listed.flags, ['network']);
  assert.equal(listed.cloneUrl, 'https://github.com/acme/notes');
  assert.deepEqual(recordVerdict(root, listed, '2026-11-19T10:00:00.000Z'), [`applications/${NOTES}.json`, `checks/${first}.json`, 'index.json']);
  const file = read(root, `applications/${NOTES}.json`);
  assert.deepEqual(Object.keys(file), ['id', 'repository', 'repositoryId', 'unpublished', 'releases']);
  assert.equal(file.repositoryId, 1000);
  assert.deepEqual(file.releases.map(({ hash, listedAt, flags, platformBuild }) => ({ hash, listedAt, flags, platformBuild })), [{ hash: first, listedAt: '2026-11-19T10:00:00.000Z', flags: ['network'], platformBuild: '' }]);
  assert.equal(file.releases[0].contributions.title, 'Notes');
  assert.deepEqual(read(root, `checks/${first}.json`), { repository: 'git@github.com:acme/notes.git', commitHash: first, outcome: 'listed', reason: '', checkedAt: '2026-11-19T10:00:00.000Z' });
  assert.deepEqual(read(root, 'index.json').applications.map(({ id, repository, title, description, color, latest }) => [id, repository, title, description, color, latest.hash]),
    [[NOTES, 'https://github.com/acme/notes', 'Notes', 'Markdown notes on every surface.', '#3b82f6', first]]);

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
  assert.deepEqual(read(root, 'index.json'), { applications: [] });

  const back = await check(added(NOTES), listingText(NOTES, 'https://github.com/acme/notes', second));
  assert.equal(back.outcome, 'listed', back.reason);
  recordVerdict(root, back, '2026-11-19T13:00:00.000Z');
  assert.equal(read(root, `applications/${NOTES}.json`).unpublished, false);
  assert.deepEqual(read(root, `applications/${NOTES}.json`).releases.map(({ hash, listedAt }) => [hash, listedAt]), [[first, '2026-11-19T10:00:00.000Z'], [second, '2026-11-19T11:00:00.000Z']]);
  assert.equal(existsSync(join(root, 'listings')), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkListing } from '../lib/check.mjs';
import { contributionsText, fakeGitHub, git, REGISTRY_ROOT, repositories } from './fixtures.mjs';

const PIPELINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTES = 'github.com/acme/notes';
const read = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

function node(script, args, cwd) {
  const ran = spawnSync('node', [join(PIPELINE, 'bin', script), ...args], { cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
}

/** The Registry as a remote, with this repository's published files on main,
 *  and a publisher's pull request as `refs/pull/<n>/head`, as GitHub keeps it. */
function registryRemote() {
  const base = mkdtempSync(join(tmpdir(), 'registry-remote-'));
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  git(['init', '-q', '--bare', '-b', 'main', origin], base);
  mkdirSync(seed);
  git(['init', '-q', '-b', 'main'], seed);
  for (const file of ['index.json', 'blocklist.json', 'platform.json']) cpSync(join(REGISTRY_ROOT, file), join(seed, file));
  for (const directory of ['listings', 'applications', 'checks']) { mkdirSync(join(seed, directory)); writeFileSync(join(seed, directory, '.gitkeep'), ''); }
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'the Registry, empty'], seed);
  git(['push', '-q', origin, 'main'], seed);
  return {
    base,
    origin,
    /** A publisher's pull request changing the files; answers its head. */
    pullRequest: (number, files) => {
      const fork = join(base, `fork-${number}`);
      git(['clone', '-q', origin, fork], base);
      git(['checkout', '-q', '-b', `list-${number}`], fork);
      for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(fork, path)), { recursive: true }); writeFileSync(join(fork, path), text); }
      git(['add', '-A'], fork);
      git(['commit', '-q', '-m', `List ${number}`], fork);
      git(['push', '-q', origin, `HEAD:refs/pull/${number}/head`], fork);
      return git(['rev-parse', 'HEAD'], fork);
    },
    /** A runner's checkout of main that has fetched the pull request. */
    runner: (number) => {
      const checkout = mkdtempSync(join(base, 'runner-'));
      git(['clone', '-q', origin, checkout], base);
      git(['config', 'user.name', 'frontier-registry[bot]'], checkout);
      git(['config', 'user.email', 'bot@example.invalid'], checkout);
      git(['fetch', '-q', 'origin', `+refs/pull/${number}/head:refs/remotes/pull/head`], checkout);
      return checkout;
    },
  };
}

test('dry run of the workflow: the change is read as data, checked, and lands on main in one merge GitHub counts as the pull request merged', async () => {
  const remote = registryRemote();
  const repos = repositories();
  const github = fakeGitHub({ repositories: { 'acme/notes': { owner: 'acme' } } });
  const release = repos.commit('acme', 'notes', { 'contributions.json': contributionsText(NOTES), 'surface.ts': 'export const registration = {};\n' });
  const head = remote.pullRequest(7, { [`listings/${NOTES}.json`]: `${JSON.stringify({ id: NOTES, repository: 'https://github.com/acme/notes', commit: release }, null, 2)}\n` });

  // An unrelated listing lands on main after the pull request was opened.
  const other = remote.runner(7);
  writeFileSync(join(other, 'checks', 'unrelated.txt'), 'x');
  git(['add', '-A'], other);
  git(['commit', '-q', '-m', 'meanwhile'], other);
  git(['push', '-q', 'origin', 'HEAD:main'], other);

  const checker = remote.runner(7);
  const scratch = mkdtempSync(join(remote.base, 'temp-'));
  assert.equal(node('pull-request.mjs', ['--repository', '.', '--base', 'HEAD', '--head', head, '--changes', join(scratch, 'changes.json'), '--listing', join(scratch, 'listing.json')], checker), `list ${NOTES}`);
  assert.deepEqual(read(scratch, 'changes.json'), [{ status: 'A', path: `listings/${NOTES}.json` }]);
  const verdict = await checkListing({ root: checker, changes: read(scratch, 'changes.json'), listingText: readFileSync(join(scratch, 'listing.json'), 'utf8'), author: 'acme', github, cloneUrlFor: repos.cloneUrlFor });
  assert.equal(verdict.outcome, 'listed', verdict.reason);
  writeFileSync(join(scratch, 'verdict.json'), JSON.stringify(verdict));

  const lander = remote.runner(7);
  const landed = spawnSync('bash', [join(PIPELINE, 'bin', 'land.sh'), join(scratch, 'verdict.json'), '7', head, 'main'], { cwd: lander, encoding: 'utf8' });
  assert.equal(landed.status, 0, landed.stderr);
  const tip = landed.stdout.trim().split('\n').pop();
  const published = mkdtempSync(join(remote.base, 'published-'));
  git(['clone', '-q', remote.origin, published], remote.base);
  assert.equal(git(['rev-parse', 'HEAD'], published), tip);
  assert.equal(git(['log', '-1', '--format=%s', 'HEAD'], published), `List ${NOTES} at ${release} (#7)`);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: published }).status, 0, 'the pull request head is on main, so GitHub shows it merged');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD~1', 'HEAD'], { cwd: published }).status, 0);
  assert.deepEqual(git(['diff', '--name-only', 'HEAD^1', 'HEAD'], published).split('\n').sort(), ['applications/github.com/acme/notes.json', `checks/${release}.json`, 'index.json', 'listings/github.com/acme/notes.json'].sort());
  assert.equal(read(published, 'index.json').applications[0].latest.hash, release);
  assert.equal(readFileSync(join(published, 'checks', 'unrelated.txt'), 'utf8'), 'x');

  const said = node('say.mjs', ['--verdict', join(scratch, 'verdict.json'), '--commit', tip], published);
  assert.match(said, new RegExp(`^Listed \\*\\*${NOTES}\\*\\* at \`${release}\`\\.`));
});

test('dry run of the workflow: a refused listing records only its check, and a pull request touching the blocklist is refused', async () => {
  const remote = registryRemote();
  const repos = repositories();
  const github = fakeGitHub({ repositories: { 'acme/notes': { owner: 'acme' } } });
  const release = repos.commit('acme', 'notes', { 'contributions.json': contributionsText('github.com/acme/elsewhere') });
  const head = remote.pullRequest(8, { [`listings/${NOTES}.json`]: JSON.stringify({ id: NOTES, repository: 'https://github.com/acme/notes', commit: release }) });
  const checker = remote.runner(8);
  const scratch = mkdtempSync(join(remote.base, 'temp-'));
  node('pull-request.mjs', ['--repository', '.', '--base', 'HEAD', '--head', head, '--changes', join(scratch, 'changes.json'), '--listing', join(scratch, 'listing.json')], checker);
  const verdict = await checkListing({ root: checker, changes: read(scratch, 'changes.json'), listingText: readFileSync(join(scratch, 'listing.json'), 'utf8'), author: 'acme', github, cloneUrlFor: repos.cloneUrlFor });
  assert.equal(verdict.outcome, 'rejected');
  writeFileSync(join(scratch, 'verdict.json'), JSON.stringify(verdict));
  const lander = remote.runner(8);
  const landed = spawnSync('bash', [join(PIPELINE, 'bin', 'land.sh'), join(scratch, 'verdict.json'), '8', head, 'main'], { cwd: lander, encoding: 'utf8' });
  assert.equal(landed.status, 0, landed.stderr);
  const published = mkdtempSync(join(remote.base, 'published-'));
  git(['clone', '-q', remote.origin, published], remote.base);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: published }).status, 1, 'a refused pull request is not merged');
  assert.deepEqual(git(['show', '--name-only', '--format=', 'HEAD'], published).split('\n'), [`checks/${release}.json`]);
  assert.deepEqual(read(published, `checks/${release}.json`), { repository: 'https://github.com/acme/notes', commitHash: release, outcome: 'rejected', reason: verdict.reason, checkedAt: read(published, `checks/${release}.json`).checkedAt });
  assert.match(verdict.reason, /declares the id github.com\/acme\/elsewhere/);

  const sneaky = remote.pullRequest(9, { 'blocklist.json': '{"applications":[],"releases":[],"publishers":[]}\n', [`listings/${NOTES}.json`]: '{}' });
  const again = remote.runner(9);
  assert.match(node('pull-request.mjs', ['--repository', '.', '--base', 'HEAD', '--head', sneaky, '--changes', join(scratch, 'changes.json'), '--listing', join(scratch, 'listing.json')], again), /changes 2: blocklist.json, listings/);
});

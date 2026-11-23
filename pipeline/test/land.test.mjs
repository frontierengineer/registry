import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkListing } from '../lib/check.mjs';
import { replayedGitHub } from '../lib/github.mjs';
import { contributionsText, fakeGitHubApi, git, REGISTRY_ROOT, repositories } from './fixtures.mjs';

const PIPELINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTES = 'github.com/acme/notes';
const read = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const run = promisify(execFile);

/** What the workflow's read job does: the pull request through GitHub's API,
 *  and GitHub's answers about the listed repository, written to a directory. */
async function readThroughApi(api, number, head, author, out) {
  const { stdout } = await run('node', [join(PIPELINE, 'bin', 'pull-request.mjs'), '--repository', 'frontierengineer/registry', '--number', String(number), '--head', head, '--author', author, '--out', out],
    { env: { ...process.env, GITHUB_API_URL: api.url, GITHUB_TOKEN: '' } });
  return stdout.trim();
}

/** What the workflow's check job does with them, holding no token. */
const checkFromRead = (root, out, author, repos) => checkListing({
  root, changes: read(out, 'changes.json'), listingText: readFileSync(join(out, 'listing.json'), 'utf8'), author,
  github: replayedGitHub(read(out, 'answers.json')), cloneUrlFor: repos.cloneUrlFor, archiveFor: repos.archiveFor,
});

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
  const api = await fakeGitHubApi({ registry: 'frontierengineer/registry', origin: remote.origin, repositories: { 'acme/notes': { owner: 'acme', repositoryId: 4242 } } });
  const release = repos.commit('acme', 'notes', { 'contributions.json': contributionsText(NOTES), 'surface.ts': 'export const registration = {};\n' });
  const head = remote.pullRequest(7, { [`listings/${NOTES}.json`]: `${JSON.stringify({ id: NOTES, repository: 'https://github.com/acme/notes', commit: release }, null, 2)}\n` });

  // An unrelated listing lands on main after the pull request was opened.
  const other = remote.runner(7);
  writeFileSync(join(other, 'checks', 'unrelated.txt'), 'x');
  git(['add', '-A'], other);
  git(['commit', '-q', '-m', 'meanwhile'], other);
  git(['push', '-q', 'origin', 'HEAD:main'], other);

  const scratch = mkdtempSync(join(remote.base, 'temp-'));
  assert.equal(await readThroughApi(api, 7, head, 'acme', scratch), `A listings/${NOTES}.json`);
  await api.close();
  assert.deepEqual(read(scratch, 'changes.json'), [{ status: 'A', path: `listings/${NOTES}.json` }]);
  assert.equal(read(scratch, 'answers.json').repositories['acme/notes'].repositoryId, 4242);
  const checker = mkdtempSync(join(remote.base, 'checker-'));
  git(['clone', '-q', remote.origin, checker], remote.base);
  const verdict = await checkFromRead(checker, scratch, 'acme', repos);
  assert.equal(verdict.outcome, 'listed', verdict.reason);
  assert.equal(verdict.repositoryId, 4242);
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
  assert.equal(read(published, `applications/${NOTES}.json`).repositoryId, 4242);
  assert.equal(read(published, `applications/${NOTES}.json`).releases[0].archiveSha256, verdict.archiveSha256, 'the landed Release pins its source archive');
  assert.match(verdict.archiveSha256, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(published, 'checks', 'unrelated.txt'), 'utf8'), 'x');

  const said = node('say.mjs', ['--verdict', join(scratch, 'verdict.json'), '--commit', tip], published);
  assert.match(said, new RegExp(`^Listed \\*\\*${NOTES}\\*\\* at \`${release}\`\\.`));
});

test('dry run of the workflow: a refused listing records only its check, and a pull request touching the blocklist is refused', async () => {
  const remote = registryRemote();
  const repos = repositories();
  const api = await fakeGitHubApi({ registry: 'frontierengineer/registry', origin: remote.origin, repositories: { 'acme/notes': { owner: 'acme' } } });
  const release = repos.commit('acme', 'notes', { 'contributions.json': contributionsText('github.com/acme/elsewhere') });
  const head = remote.pullRequest(8, { [`listings/${NOTES}.json`]: JSON.stringify({ id: NOTES, repository: 'https://github.com/acme/notes', commit: release }) });
  const scratch = mkdtempSync(join(remote.base, 'temp-'));
  await readThroughApi(api, 8, head, 'acme', scratch);
  const checker = mkdtempSync(join(remote.base, 'checker-'));
  git(['clone', '-q', remote.origin, checker], remote.base);
  const verdict = await checkFromRead(checker, scratch, 'acme', repos);
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
  await readThroughApi(api, 9, sneaky, 'acme', scratch);
  await assert.rejects(readThroughApi(api, 9, 'f'.repeat(40), 'acme', scratch), /the run for its newer head checks it/);
  await api.close();
  const sneakyVerdict = await checkFromRead(checker, scratch, 'acme', repos);
  assert.equal(sneakyVerdict.outcome, 'rejected');
  assert.match(sneakyVerdict.reason, /changes 2: blocklist.json, listings/);
});

test('dry run of the workflow: a refused commit is checked again when its pull request is reopened, and lands; only a listed check is final', async () => {
  const ORG = 'github.com/acme-org/notes';
  const remote = registryRemote();
  const repos = repositories();
  const release = repos.commit('acme-org', 'notes', { 'contributions.json': contributionsText(ORG), 'surface.ts': 'export const registration = {};\n' });
  const head = remote.pullRequest(10, { [`listings/${ORG}.json`]: `${JSON.stringify({ id: ORG, repository: 'https://github.com/acme-org/notes', commit: release }, null, 2)}\n` });
  const known = { 'acme-org/notes': { owner: 'acme-org', type: 'Organization', repositoryId: 5151 } };

  /** One run of the workflow on pull request 10: read, check, land. */
  const runOnce = async (members) => {
    const api = await fakeGitHubApi({ registry: 'frontierengineer/registry', origin: remote.origin, repositories: known, members });
    const scratch = mkdtempSync(join(remote.base, 'temp-'));
    await readThroughApi(api, 10, head, 'alice', scratch);
    await api.close();
    const checker = mkdtempSync(join(remote.base, 'checker-'));
    git(['clone', '-q', remote.origin, checker], remote.base);
    const verdict = await checkFromRead(checker, scratch, 'alice', repos);
    writeFileSync(join(scratch, 'verdict.json'), JSON.stringify(verdict));
    const landed = spawnSync('bash', [join(PIPELINE, 'bin', 'land.sh'), join(scratch, 'verdict.json'), '10', head, 'main'], { cwd: remote.runner(10), encoding: 'utf8' });
    assert.equal(landed.status, 0, landed.stderr);
    const published = mkdtempSync(join(remote.base, 'published-'));
    git(['clone', '-q', remote.origin, published], remote.base);
    return { verdict, published };
  };

  // alice is a member of acme-org, privately: refused, and the refusal is recorded on main.
  const first = await runOnce({});
  assert.equal(first.verdict.outcome, 'rejected');
  assert.match(first.verdict.reason, /open it as a public member of acme-org/);
  assert.equal(read(first.published, `checks/${release}.json`).outcome, 'rejected');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: first.published }).status, 1);

  // Her membership made public, the same pull request reopened: checked again from the start, listed and merged.
  const second = await runOnce({ 'acme-org': ['alice'] });
  assert.equal(second.verdict.outcome, 'listed', second.verdict.reason);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: second.published }).status, 0, 'the reopened pull request is merged');
  assert.deepEqual(read(second.published, `checks/${release}.json`), { repository: 'https://github.com/acme-org/notes', commitHash: release, outcome: 'listed', reason: '', checkedAt: read(second.published, `checks/${release}.json`).checkedAt });
  assert.deepEqual(read(second.published, 'index.json').applications.map(({ id, latest }) => [id, latest.hash]), [[ORG, release]]);
  assert.equal(read(second.published, `applications/${ORG}.json`).repositoryId, 5151);

  // Listed is final: a later refusal of the same hash cannot overwrite it.
  const scratch = mkdtempSync(join(remote.base, 'temp-'));
  writeFileSync(join(scratch, 'verdict.json'), JSON.stringify({ outcome: 'rejected', id: ORG, repository: 'https://github.com/acme-org/notes', commit: release, reason: 'refused later' }));
  node('record.mjs', ['--root', '.', '--verdict', join(scratch, 'verdict.json')], second.published);
  assert.equal(read(second.published, `checks/${release}.json`).outcome, 'listed');
});

test('the read and land jobs install no packages, so what they run loads without them', () => {
  const bare = mkdtempSync(join(tmpdir(), 'registry-bare-'));
  cpSync(join(PIPELINE, 'bin'), join(bare, 'bin'), { recursive: true });
  cpSync(join(PIPELINE, 'lib'), join(bare, 'lib'), { recursive: true });
  writeFileSync(join(bare, 'package.json'), readFileSync(join(PIPELINE, 'package.json')));
  for (const script of ['pull-request.mjs', 'record.mjs', 'say.mjs']) {
    const ran = spawnSync('node', [join(bare, 'bin', script)], { cwd: bare, encoding: 'utf8' });
    assert.doesNotMatch(ran.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/, `${script} needs a package: ${ran.stderr}`);
  }
});

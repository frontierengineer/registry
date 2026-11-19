// The checks a listing pull request passes, in order, each refusing with a
// reason the publisher can act on. The Registry's own files are read from the
// base branch; the pull request's listing is data; the Application's
// repository is untrusted code that is cloned, scanned and built, never run.
//
// The verdict is one of:
//   { outcome: 'listed', id, repository, cloneUrl, repositoryId, commit, flags, contributions }
//   { outcome: 'unpublished', id }
//   { outcome: 'rejected', id, repository, commit, reason }   (id, repository and commit '' when the listing never named them)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { breakingChanges } from './breaking.mjs';
import { buildApplication } from './build.mjs';
import { CONTRIBUTIONS_FILE, contributionsOf, isObject } from './contributions.mjs';
import { cloneUrlOf, gitHubPartsOf, idProblem, identityOfRepository, isCommitHash } from './identity.mjs';
import { applicationFiles, applicationPath, blocklistReason, readBlocklist, readJson } from './registry.mjs';
import { flagsOf, packagesProblem, secretIn, SIZE_LIMIT_BYTES } from './scan.mjs';
import { squattedOn } from './typosquat.mjs';

const LISTING = /^listings\/(.+)\.json$/;
const LISTING_LIMIT_BYTES = 4096;
const CONTRIBUTIONS_LIMIT_BYTES = 256 * 1024;
const LISTING_KEYS = ['id', 'repository', 'commit'];
const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;

const rejected = (reason, listing = {}) => ({ outcome: 'rejected', id: listing.id ?? '', repository: listing.repository ?? '', commit: listing.commit ?? '', reason });

function git(args, cwd) {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } });
  return { ok: ran.status === 0, out: ran.stdout ?? '', err: (ran.stderr ?? '').trim() };
}

/** Which one listing the pull request changes, and how; or why it is not a
 *  listing pull request. `changes` is [{ status: A|M|D|R|C|T, path }]. */
export function listingChangeOf(changes) {
  if (changes.length === 0) return { problem: 'the pull request changes nothing' };
  if (changes.length > 1) return { problem: `a listing pull request changes one file, listings/<application id>.json, and this one changes ${changes.length}: ${changes.map(({ path }) => path).join(', ')}` };
  const [{ status, path }] = changes;
  const matched = LISTING.exec(path);
  if (matched === null) return { problem: `a listing pull request changes only listings/<application id>.json, and this one changes ${path}; the blocklist and the generated files are changed by the Registry's maintainers and its pipeline` };
  const id = matched[1];
  if (status === 'A' || status === 'M') return { kind: 'list', id, path };
  if (status === 'D') return { kind: 'unpublish', id, path };
  return { problem: `${path} is ${status === 'R' ? 'renamed' : 'changed in a way a listing is not'}; add, replace or remove the one listing file` };
}

/** The listing file's content, checked: { listing } or { problem }. */
export function listingOf(text, id) {
  if (Buffer.byteLength(text, 'utf8') > LISTING_LIMIT_BYTES) return { problem: `a listing is one small file, and this one is over ${LISTING_LIMIT_BYTES} bytes` };
  let value;
  try {
    value = JSON.parse(text);
  } catch (failure) {
    return { problem: `the listing is not JSON: ${failure.message}` };
  }
  if (!isObject(value)) return { problem: 'the listing is not a JSON object' };
  const extra = Object.keys(value).filter((key) => !LISTING_KEYS.includes(key));
  if (extra.length > 0) return { problem: `a listing names only id, repository and commit, and this one also has ${extra.join(', ')}` };
  const listing = { id: value.id, repository: value.repository, commit: value.commit };
  if (typeof listing.id !== 'string' || typeof listing.repository !== 'string' || typeof listing.commit !== 'string') return { problem: 'the listing must name id, repository and commit, each as text', listing };
  if (listing.id !== id) return { problem: `the listing at listings/${id}.json names the id ${listing.id}; the file is named for its id`, listing };
  const wrongId = idProblem(listing.id);
  if (wrongId !== null) return { problem: wrongId, listing };
  if (!isCommitHash(listing.commit)) return { problem: `the commit "${listing.commit}" is not a full commit hash, 40 lower-case hex characters`, listing };
  const identity = identityOfRepository(listing.repository);
  if (identity === null) return { problem: `${listing.repository} is not a repository an id can be taken from`, listing };
  if (identity !== listing.id) return { problem: `an Application's id is its repository's: ${listing.repository} gives ${identity}, not ${listing.id}`, listing };
  if (gitHubPartsOf(listing.id) === null) return { problem: `the Registry lists Applications published from GitHub, github.com/<owner>/<name>, and ${listing.id} is not one`, listing };
  return { listing };
}

/** Whether the author owns the id's repository, as GitHub answers:
 *  { owner, repositoryId } | { problem } | { unavailable }. */
export async function ownershipProblem(github, id, author) {
  const { owner, name } = gitHubPartsOf(id);
  const found = await github.repository(owner, name);
  if (found.kind === 'unavailable') return { unavailable: found.reason };
  if (found.kind === 'missing') return { problem: `github.com/${owner}/${name} does not exist or is not public; the Registry lists only public repositories, which every install can clone` };
  if (found.kind === 'moved') return { problem: `github.com/${owner}/${name} has moved; publish from its new place, which gives the Application its new id` };
  if (found.isPrivate) return { problem: `github.com/${owner}/${name} is private; every install clones a listed Application anonymously` };
  if (found.fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) return { problem: `github.com/${owner}/${name} is now ${found.fullName}; publish from there` };
  if (found.ownerLogin.toLowerCase() === author.toLowerCase()) return { owner: found.ownerLogin, repositoryId: found.repositoryId };
  if (found.ownerType === 'Organization') {
    const member = await github.publicMember(found.ownerLogin, author);
    if (member.kind === 'unavailable') return { unavailable: member.reason };
    if (member.kind === 'member') return { owner: found.ownerLogin, repositoryId: found.repositoryId };
    return { problem: `${author} opened this pull request, and ${found.ownerLogin} owns ${found.fullName}; a listing comes from its repository's owner, so open it as a public member of ${found.ownerLogin} (make your membership public on github.com/orgs/${found.ownerLogin}/people)` };
  }
  return { problem: `${author} opened this pull request, and ${found.ownerLogin} owns ${found.fullName}; a listing comes from its repository's owner` };
}

/** Why the repository is not the one the Registry listed under this id
 *  before, or null. GitHub's numeric id stays with a repository through
 *  renames and transfers and is never reused, so a name taken over after
 *  its repository was deleted or moved is a different id. */
function takenOver(existing, owned, id) {
  if (existing === null || existing.repositoryId === undefined || existing.repositoryId === owned.repositoryId) return null;
  return `${id} is a different GitHub repository from the one the Registry listed under that id (repository ${existing.repositoryId}, now ${owned.repositoryId}); an id stays with the repository it was first listed from`;
}

/** Asks GitHub everything the check will need, so the job that asks holds
 *  the token and the job that checks holds none. */
export async function askGitHub({ changes, listingText, author, github }) {
  const change = listingChangeOf(changes);
  if (change.problem !== undefined) return;
  if (change.kind === 'unpublish') { await ownershipProblem(github, change.id, author); return; }
  const read = listingOf(listingText ?? '', change.id);
  if (read.problem === undefined) await ownershipProblem(github, read.listing.id, author);
}

/** Clones the repository into a directory of its own and places the commit
 *  there, refusing a commit the repository's own branches and tags do not
 *  hold (GitHub serves any commit of a fork through its parent). */
function cloned(cloneUrl, commit) {
  const directory = mkdtempSync(join(tmpdir(), 'registry-check-'));
  const source = join(directory, 'source');
  const clone = git(['clone', '--quiet', '--no-checkout', cloneUrl, source]);
  if (!clone.ok) return { directory, problem: `${cloneUrl} cannot be cloned: ${clone.err.split('\n')[0]}` };
  const present = git(['cat-file', '-e', `${commit}^{commit}`], source);
  const holding = present.ok ? git(['for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/remotes', 'refs/tags', 'refs/heads'], source) : { ok: false, out: '' };
  if (!present.ok || holding.out.trim() === '') return { directory, problem: `${commit} is not on any branch or tag of ${cloneUrl}; push it there first` };
  const checkout = git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit], source);
  if (!checkout.ok) return { directory, problem: `${commit} cannot be checked out: ${checkout.err.split('\n')[0]}` };
  return { directory, source };
}

function treeOf(source, commit) {
  const listed = git(['ls-tree', '-r', '-l', '-z', commit], source);
  return listed.out.split('\0').filter((line) => line !== '').map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type, , size] = meta.split(/\s+/);
    return { mode, type, path, size: Number(size) || 0 };
  });
}

/**
 * Checks one listing pull request.
 *   root         the Registry's files, at the base branch
 *   changes      [{ status, path }] the pull request makes against its base
 *   listingText  the listing file's content at the pull request's head; null when removed
 *   author       the login that opened the pull request
 *   github       the GitHub answers (lib/github.mjs)
 *   cloneUrlFor  the URL to clone an id's repository from; the anonymous HTTPS URL on GitHub
 */
export async function checkListing({ root, changes, listingText, author, github, cloneUrlFor = (parts) => cloneUrlOf(parts) }) {
  const change = listingChangeOf(changes);
  if (change.problem !== undefined) return rejected(change.problem);
  const existing = readJson(root, applicationPath(change.id));
  const blocklist = readBlocklist(root);

  if (change.kind === 'unpublish') {
    if (existing === null || existing.unpublished === true) return rejected(`the Registry does not list ${change.id}, so there is nothing to unpublish`, { id: change.id });
    const owned = await ownershipProblem(github, change.id, author);
    if (owned.unavailable !== undefined) return { outcome: 'unavailable', reason: owned.unavailable };
    if (owned.problem !== undefined) return rejected(owned.problem, { id: change.id });
    const moved = takenOver(existing, owned, change.id);
    if (moved !== null) return rejected(moved, { id: change.id });
    return { outcome: 'unpublished', id: change.id };
  }

  const read = listingOf(listingText ?? '', change.id);
  if (read.problem !== undefined) return rejected(read.problem, read.listing ?? { id: change.id });
  const { listing } = read;

  const owned = await ownershipProblem(github, listing.id, author);
  if (owned.unavailable !== undefined) return { outcome: 'unavailable', reason: owned.unavailable };
  if (owned.problem !== undefined) return rejected(owned.problem, listing);
  const moved = takenOver(existing, owned, listing.id);
  if (moved !== null) return rejected(moved, listing);

  const blocked = blocklistReason(blocklist, listing.id, listing.commit);
  if (blocked !== '') return rejected(`the Registry's blocklist names it: ${blocked}`, listing);

  const others = applicationFiles(root).map((file) => file.id).filter((id) => id !== listing.id);
  const sameButCase = others.find((id) => id.toLowerCase() === listing.id.toLowerCase());
  if (sameButCase !== undefined) return rejected(`the Registry lists it as ${sameButCase}; publish with that id`, listing);
  const squatted = squattedOn(listing.id, others);
  if (squatted !== null) return rejected(`${listing.id} is within typosquatting distance of ${squatted}, which the Registry lists; choose a name that cannot be mistaken for it`, listing);

  const previous = existing?.releases ?? [];
  const again = previous.find((release) => release.hash === listing.commit);
  if (again !== undefined && !(existing.unpublished === true && previous[previous.length - 1] === again)) {
    return rejected(`${listing.commit} is already a Release of ${listing.id}, listed ${again.listedAt}; a Release is listed once`, listing);
  }

  const parts = gitHubPartsOf(listing.id);
  const place = cloned(cloneUrlFor(parts), listing.commit);
  try {
    if (place.problem !== undefined) return rejected(place.problem, listing);
    const { source } = place;
    const tree = treeOf(source, listing.commit);
    const size = tree.reduce((total, entry) => total + entry.size, 0);
    if (size > SIZE_LIMIT_BYTES) return rejected(`its files come to ${(size / 1024 / 1024).toFixed(1)} MiB, over the Registry's ${SIZE_LIMIT_BYTES / 1024 / 1024} MiB`, listing);
    if (tree.some((entry) => entry.type === 'commit')) return rejected('it holds a git submodule, and an install clones the repository alone', listing);

    const declared = tree.find((entry) => entry.path === CONTRIBUTIONS_FILE && entry.type === 'blob' && entry.mode !== '120000');
    if (declared === undefined) return rejected(`it has no ${CONTRIBUTIONS_FILE} at its root at ${listing.commit}`, listing);
    if (declared.size > CONTRIBUTIONS_LIMIT_BYTES) return rejected(`its ${CONTRIBUTIONS_FILE} is over ${CONTRIBUTIONS_LIMIT_BYTES / 1024} KiB, and the Registry keeps it with every Release`, listing);
    const declaredText = readFileSync(join(source, CONTRIBUTIONS_FILE), 'utf8');
    const contributions = contributionsOf(declaredText);
    if (typeof contributions === 'string') return rejected(contributions, listing);
    if (contributions.id !== listing.id) return rejected(`its ${CONTRIBUTIONS_FILE} declares the id ${contributions.id}, and it is published as ${listing.id}; the id is its repository's`, listing);

    const last = previous[previous.length - 1];
    if (last !== undefined && again === undefined) {
      const broken = breakingChanges(last.contributions ?? {}, contributions);
      if (broken.length > 0) return rejected(`everything a Release publishes stays, and against ${last.hash} ${broken.join('; ')}. Keep the old beside the new, under a new id`, listing);
    }

    const readIfThere = (path) => (tree.some((entry) => entry.path === path) ? readFileSync(join(source, path), 'utf8') : null);
    const packages = packagesProblem(readIfThere('package.json'), readIfThere('package-lock.json'));
    if (packages !== null) return rejected(packages, listing);

    const texts = tree
      .filter((entry) => entry.type === 'blob' && entry.mode !== '120000' && entry.size <= TEXT_LIMIT_BYTES)
      .map((entry) => ({ path: entry.path, bytes: readFileSync(join(source, entry.path)) }))
      .filter(({ bytes }) => !bytes.includes(0))
      .map(({ path, bytes }) => ({ path, text: bytes.toString('utf8') }));
    const secret = secretIn(texts);
    if (secret !== null) return rejected(`it holds ${secret}; revoke it, remove it from the repository and publish again`, listing);

    const built = await buildApplication(source);
    if (built.problem !== undefined) return rejected(built.problem, listing);

    return { outcome: 'listed', id: listing.id, repository: listing.repository, cloneUrl: cloneUrlOf(parts), repositoryId: owned.repositoryId, commit: listing.commit, flags: flagsOf(built.bundles), contributions };
  } finally {
    rmSync(place.directory, { recursive: true, force: true });
  }
}

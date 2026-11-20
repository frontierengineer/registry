// A listing pull request read as data: which one listing it changes, the
// listing file's shape, and whether its author owns the listed repository, as
// GitHub answers. The workflow's read job, which holds a token and installs
// no packages, loads only this and what it imports, never the checker that
// builds an Application (lib/check.mjs, which needs esbuild).

import { isObject } from './contributions.mjs';
import { gitHubPartsOf, idProblem, identityOfRepository, isCommitHash } from './identity.mjs';

const LISTING = /^listings\/(.+)\.json$/;
const LISTING_LIMIT_BYTES = 4096;
const LISTING_KEYS = ['id', 'repository', 'commit'];

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

/** Asks GitHub everything the check will need, so the job that asks holds
 *  the token and the job that checks holds none. */
export async function askGitHub({ changes, listingText, author, github }) {
  const change = listingChangeOf(changes);
  if (change.problem !== undefined) return;
  if (change.kind === 'unpublish') { await ownershipProblem(github, change.id, author); return; }
  const read = listingOf(listingText ?? '', change.id);
  if (read.problem === undefined) await ownershipProblem(github, read.listing.id, author);
}

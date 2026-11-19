// An Application's id is its repository's, as Frontier's Host derives it when
// a person publishes: `github.com/<owner>/<name>`. This is the Host's rule
// (containers/host/modules/application_records/internal/repository.ts), kept
// here in step with it.

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^(?:[^@/]+@)?([^:/]+):(.+)$/;
const USER = /^[^@/]+@/;
const GIT_SUFFIX = /\.git$/;
const ID_LIMIT = 200;
const ID_CHARACTERS = /^[A-Za-z0-9._\-/]+$/;
const BAD_SEGMENTS = new Set(['', '.', '..']);
const GITHUB = 'github.com';
const COMMIT = /^[0-9a-f]{40}$/;

/** The id a repository URL gives, or null when none can be taken from it. */
export function identityOfRepository(repository) {
  const trimmed = String(repository).trim();
  let path;
  if (SCHEME.test(trimmed)) path = trimmed.replace(SCHEME, '').replace(USER, '').replace(/^\/+/, '');
  else {
    const scp = SCP_LIKE.exec(trimmed);
    if (scp === null) return null;
    path = `${scp[1] ?? ''}/${scp[2] ?? ''}`;
  }
  const identity = path.replace(/\/+$/, '').replace(GIT_SUFFIX, '');
  if (identity.length > ID_LIMIT || !ID_CHARACTERS.test(identity)) return null;
  const segments = identity.split('/');
  if (segments.length < 2 || segments.some((segment) => BAD_SEGMENTS.has(segment))) return null;
  return identity;
}

/** Why an id is not one the Host accepts, or null. */
export function idProblem(id) {
  if (typeof id !== 'string' || id.length === 0) return 'the id is empty';
  if (id.length > ID_LIMIT) return `the id "${id}" is longer than ${ID_LIMIT} characters`;
  if (!ID_CHARACTERS.test(id)) return `the id "${id}" holds a character other than a letter, a digit, ".", "-", "_" or "/"`;
  if (id.split('/').some((segment) => BAD_SEGMENTS.has(segment))) return `the id "${id}" has an empty, "." or ".." segment`;
  return null;
}

/** The owner and name of a GitHub id, `github.com/<owner>/<name>`, or null. */
export function gitHubPartsOf(id) {
  const segments = String(id).split('/');
  if (segments.length !== 3 || segments[0].toLowerCase() !== GITHUB) return null;
  const [, owner, name] = segments;
  return { owner, name };
}

/** The URL every install clones from: anonymous HTTPS, whatever form the
 *  publisher gave. */
export const cloneUrlOf = ({ owner, name }) => `https://github.com/${owner}/${name}`;

export const isCommitHash = (hash) => typeof hash === 'string' && COMMIT.test(hash);

/** The publisher of an id: everything before its last segment, as the Host's
 *  blocklist matches it, such as `github.com/acme`. */
export const publisherOf = (id) => String(id).split('/').slice(0, -1).join('/');

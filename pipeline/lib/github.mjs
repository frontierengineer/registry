// What the pipeline asks GitHub, read-only: who owns a repository and whether
// the person who opened the pull request is that owner. A token raises the
// rate limit and is never needed for an answer: every question here is about
// public data.

const API = 'https://api.github.com';

async function ask(path, token, api = API) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'frontier-registry-pipeline' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${api}${path}`, { headers, redirect: 'manual' });
  return response;
}

/** The live GitHub, for the pipeline on GitHub Actions. */
export function liveGitHub(token = process.env.GITHUB_TOKEN ?? '', api = API) {
  return {
    /** { kind: 'found', repositoryId, fullName, ownerLogin, ownerType, isPrivate, isArchived } | { kind: 'missing' } | { kind: 'moved', to } | { kind: 'unavailable', reason } */
    repository: async (owner, name) => {
      let response;
      try {
        response = await ask(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token, api);
      } catch (failure) {
        return { kind: 'unavailable', reason: `GitHub cannot be reached: ${failure.message}` };
      }
      if (response.status === 404) return { kind: 'missing' };
      if (response.status === 301 || response.status === 302 || response.status === 307) return { kind: 'moved', to: response.headers.get('location') ?? '' };
      if (!response.ok) return { kind: 'unavailable', reason: `GitHub answered ${response.status} for ${owner}/${name}` };
      const body = await response.json();
      return { kind: 'found', repositoryId: body.id, fullName: body.full_name, ownerLogin: body.owner?.login ?? '', ownerType: body.owner?.type ?? '', isPrivate: body.private === true, isArchived: body.archived === true };
    },
    /** Whether the person is a public member of the organization:
     *  { kind: 'member' } | { kind: 'not_member' } | { kind: 'unavailable', reason } */
    publicMember: async (organization, login) => {
      let response;
      try {
        response = await ask(`/orgs/${encodeURIComponent(organization)}/public_members/${encodeURIComponent(login)}`, token, api);
      } catch (failure) {
        return { kind: 'unavailable', reason: `GitHub cannot be reached: ${failure.message}` };
      }
      if (response.status === 204) return { kind: 'member' };
      if (response.status === 404) return { kind: 'not_member' };
      return { kind: 'unavailable', reason: `GitHub answered ${response.status} for ${organization}'s members` };
    },
  };
}

/** GitHub's answers, asked once by the job that holds a token and replayed
 *  in the job that checks, which holds none. */
export function recordingGitHub(github) {
  const answers = { repositories: {}, members: {} };
  return {
    answers,
    repository: async (owner, name) => (answers.repositories[`${owner}/${name}`] = await github.repository(owner, name)),
    publicMember: async (organization, login) => (answers.members[`${organization}/${login}`] = await github.publicMember(organization, login)),
  };
}

export function replayedGitHub(answers) {
  const replay = (held, key) => held?.[key] ?? { kind: 'unavailable', reason: `GitHub was not asked about ${key} before the check` };
  return {
    repository: async (owner, name) => replay(answers.repositories, `${owner}/${name}`),
    publicMember: async (organization, login) => replay(answers.members, `${organization}/${login}`),
  };
}

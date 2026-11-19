// What the pipeline asks GitHub, read-only: who owns a repository and whether
// the person who opened the pull request is that owner. A token raises the
// rate limit and is never needed for an answer: every question here is about
// public data.

const API = 'https://api.github.com';

async function ask(path, token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'frontier-registry-pipeline' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { headers, redirect: 'manual' });
  return response;
}

/** The live GitHub, for the pipeline on GitHub Actions. */
export function liveGitHub(token = process.env.GITHUB_TOKEN ?? '') {
  return {
    /** { kind: 'found', fullName, ownerLogin, ownerType, isPrivate, isArchived } | { kind: 'missing' } | { kind: 'moved', to } | { kind: 'unavailable', reason } */
    repository: async (owner, name) => {
      let response;
      try {
        response = await ask(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token);
      } catch (failure) {
        return { kind: 'unavailable', reason: `GitHub cannot be reached: ${failure.message}` };
      }
      if (response.status === 404) return { kind: 'missing' };
      if (response.status === 301 || response.status === 302 || response.status === 307) return { kind: 'moved', to: response.headers.get('location') ?? '' };
      if (!response.ok) return { kind: 'unavailable', reason: `GitHub answered ${response.status} for ${owner}/${name}` };
      const body = await response.json();
      return { kind: 'found', fullName: body.full_name, ownerLogin: body.owner?.login ?? '', ownerType: body.owner?.type ?? '', isPrivate: body.private === true, isArchived: body.archived === true };
    },
    /** Whether the person is a public member of the organization:
     *  { kind: 'member' } | { kind: 'not_member' } | { kind: 'unavailable', reason } */
    publicMember: async (organization, login) => {
      let response;
      try {
        response = await ask(`/orgs/${encodeURIComponent(organization)}/public_members/${encodeURIComponent(login)}`, token);
      } catch (failure) {
        return { kind: 'unavailable', reason: `GitHub cannot be reached: ${failure.message}` };
      }
      if (response.status === 204) return { kind: 'member' };
      if (response.status === 404) return { kind: 'not_member' };
      return { kind: 'unavailable', reason: `GitHub answered ${response.status} for ${organization}'s members` };
    },
  };
}

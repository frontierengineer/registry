// A pull request's change, read through GitHub's API as data: which files it
// changes and the listing file's content at its head. Nothing of the pull
// request is checked out, fetched or run.

import { listingChangeOf } from './check.mjs';

const API = 'https://api.github.com';
const STATUS = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'T', unchanged: 'U' };
const PAGE = 100;

const headersOf = (token, accept = 'application/vnd.github+json') => ({
  Accept: accept,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'frontier-registry-pipeline',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function asked(url, token, accept) {
  const response = await fetch(url, { headers: headersOf(token, accept) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${new URL(url).pathname}`);
  return response;
}

/**
 * { changes: [{ status, path }], listingText } of pull request `number` of
 * `repository` (`owner/name`), at `head`; throws when GitHub cannot answer or
 * the pull request has moved past `head`, since a newer run checks that.
 */
export async function readPullRequest({ repository, number, head, token = '', api = API }) {
  const pull = await (await asked(`${api}/repos/${repository}/pulls/${number}`, token)).json();
  if (pull.head?.sha !== head) throw new Error(`the pull request's head is ${pull.head?.sha}, not ${head}; the run for its newer head checks it`);
  const changes = [];
  for (let page = 1; ; page += 1) {
    const files = await (await asked(`${api}/repos/${repository}/pulls/${number}/files?per_page=${PAGE}&page=${page}`, token)).json();
    changes.push(...files.map((file) => ({ status: STATUS[file.status] ?? '?', path: file.filename })));
    if (files.length < PAGE || changes.length > 1) break;
  }
  const change = listingChangeOf(changes);
  if (change.kind !== 'list') return { changes, listingText: null };
  const path = change.path.split('/').map(encodeURIComponent).join('/');
  const listingText = await (await asked(`${api}/repos/${repository}/contents/${path}?ref=${head}`, token, 'application/vnd.github.raw')).text();
  return { changes, listingText };
}

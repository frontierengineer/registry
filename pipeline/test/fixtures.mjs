// Local stand-ins for what the pipeline reaches on GitHub: Application
// repositories as git repositories on disk, and GitHub's answers about who
// owns them.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function git(args, cwd) {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  if (ran.status !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr}`);
  return ran.stdout.trim();
}

/** A copy of the Registry as this repository publishes it, empty of
 *  listings, in a directory of its own. */
export function emptyRegistry() {
  const root = mkdtempSync(join(tmpdir(), 'registry-root-'));
  for (const file of ['index.json', 'blocklist.json', 'platform.json']) cpSync(join(REGISTRY_ROOT, file), join(root, file));
  for (const directory of ['listings', 'applications', 'checks']) mkdirSync(join(root, directory));
  return root;
}

/** Repositories on disk, standing for github.com/<owner>/<name>. */
export function repositories() {
  const base = mkdtempSync(join(tmpdir(), 'registry-repos-'));
  const pathOf = ({ owner, name }) => join(base, owner.toLowerCase(), name.toLowerCase());
  return {
    cloneUrlFor: (parts) => pathOf(parts),
    /** GitHub's codeload, answered from the repositories on disk: the
     *  gzipped tar `git archive` makes of the commit; `failed` for a commit
     *  or repository not there. */
    archiveFor: async (url) => {
      const found = /^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(url);
      if (found === null) return { kind: 'failed', reason: `${url} answered 404` };
      const ran = spawnSync('git', ['archive', '--format=tar.gz', `--prefix=${found[2]}-${found[3]}/`, found[3]], { cwd: pathOf({ owner: found[1], name: found[2] }) });
      return ran.status === 0 ? { kind: 'downloaded', bytes: new Uint8Array(ran.stdout) } : { kind: 'failed', reason: `${url} answered 404` };
    },
    /** Commits the files to the repository's main branch; answers the hash. */
    commit: (owner, name, files) => {
      const path = pathOf({ owner, name });
      mkdirSync(path, { recursive: true });
      if (!existsSync(join(path, '.git'))) git(['init', '-q', '-b', 'main'], path);
      for (const [file, text] of Object.entries(files)) {
        if (text === null) { spawnSync('git', ['rm', '-q', file], { cwd: path }); continue; }
        mkdirSync(dirname(join(path, file)), { recursive: true });
        writeFileSync(join(path, file), text);
      }
      git(['add', '-A'], path);
      git(['commit', '-q', '--allow-empty', '-m', 'release'], path);
      return git(['rev-parse', 'HEAD'], path);
    },
    /** A commit no branch or tag holds, as a fork's commit served through its
     *  parent would be. */
    dangling: (owner, name) => {
      const path = pathOf({ owner, name });
      const tree = git(['rev-parse', 'HEAD^{tree}'], path);
      return git(['commit-tree', tree, '-m', 'not on any branch'], path);
    },
  };
}

/** GitHub's answers: each repository's owner and kind, and each
 *  organization's public members. */
export function fakeGitHub({ repositories: known = {}, members = {} } = {}) {
  return {
    repository: async (owner, name) => {
      const found = known[`${owner}/${name}`.toLowerCase()];
      if (found === undefined) return { kind: 'missing' };
      return { kind: 'found', repositoryId: found.repositoryId ?? 1000, fullName: found.fullName ?? `${owner}/${name}`, ownerLogin: found.owner ?? owner, ownerType: found.type ?? 'User', isPrivate: found.private === true, isArchived: false };
    },
    publicMember: async (organization, login) => ((members[organization.toLowerCase()] ?? []).includes(login.toLowerCase()) ? { kind: 'member' } : { kind: 'not_member' }),
  };
}

export const contributionsText = (id, more = {}) => `// Notes, as a person writes it\n${JSON.stringify({ id, title: 'Notes', color: '#3b82f6', description: 'Markdown notes on every surface.', ...more }, null, 2).replace(/\n}$/, ',\n}')}\n`;

/** GitHub's REST API as the pipeline reads it, answered from a bare
 *  repository standing for the Registry, where each pull request is
 *  `refs/pull/<n>/head`, and from a table of repositories and members.
 *  Answers { url, close }. */
export async function fakeGitHubApi({ registry, origin, repositories: known = {}, members = {} }) {
  const { createServer } = await import('node:http');
  const WORDS = { A: 'added', D: 'removed', M: 'modified', R: 'renamed', C: 'copied', T: 'changed' };
  const at = (args) => spawnSync('git', args, { cwd: origin, encoding: 'utf8' });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)); };
    const pull = new RegExp(`^/repos/${registry}/pulls/(\\d+)(/files)?$`).exec(url.pathname);
    const contents = new RegExp(`^/repos/${registry}/contents/(.+)$`).exec(url.pathname);
    const repository = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const member = /^\/orgs\/([^/]+)\/public_members\/([^/]+)$/.exec(url.pathname);
    if (pull) {
      const head = at(['rev-parse', `refs/pull/${pull[1]}/head`]).stdout.trim();
      if (!pull[2]) return send(200, { number: Number(pull[1]), head: { sha: head } });
      if (url.searchParams.get('page') !== '1') return send(200, []);
      const base = at(['merge-base', 'main', head]).stdout.trim();
      const fields = at(['diff', '--name-status', '--no-renames', '-z', base, head]).stdout.split('\0').filter((field) => field !== '');
      const files = [];
      for (let index = 0; index + 1 < fields.length; index += 2) files.push({ status: WORDS[fields[index][0]], filename: fields[index + 1] });
      return send(200, files);
    }
    if (contents) {
      const shown = at(['show', `${url.searchParams.get('ref')}:${decodeURIComponent(contents[1])}`]);
      return shown.status === 0 ? send(200, shown.stdout) : send(404, { message: 'Not Found' });
    }
    if (member) return send((members[member[1].toLowerCase()] ?? []).includes(member[2].toLowerCase()) ? 204 : 404);
    if (repository) {
      const found = known[`${repository[1]}/${repository[2]}`.toLowerCase()];
      if (found === undefined) return send(404, { message: 'Not Found' });
      return send(200, { id: found.repositoryId ?? 1000, full_name: `${repository[1]}/${repository[2]}`, private: found.private === true, archived: false, owner: { login: found.owner ?? repository[1], type: found.type ?? 'User' } });
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

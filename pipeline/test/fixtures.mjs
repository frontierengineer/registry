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
      return { kind: 'found', fullName: found.fullName ?? `${owner}/${name}`, ownerLogin: found.owner ?? owner, ownerType: found.type ?? 'User', isPrivate: found.private === true, isArchived: false };
    },
    publicMember: async (organization, login) => ((members[organization.toLowerCase()] ?? []).includes(login.toLowerCase()) ? { kind: 'member' } : { kind: 'not_member' }),
  };
}

export const contributionsText = (id, more = {}) => `// Notes, as a person writes it\n${JSON.stringify({ id, title: 'Notes', color: '#3b82f6', description: 'Markdown notes on every surface.', ...more }, null, 2).replace(/\n}$/, ',\n}')}\n`;

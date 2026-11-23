// Writes a verdict into the Registry's files, at the moment given, which is
// the Release's time: when the Registry listed its hash. Run on the newest
// default branch with the pull request merged in (bin/land.sh), and again
// from the newest if another landing wins the push, so each run starts from
// every listing before it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isArchiveSha256 } from './archive.mjs';
import { gitHubPartsOf, idProblem, isCommitHash } from './identity.mjs';
import { applicationPath, checkPath, INDEX, indexOf, platformBuildAt, readJson, writeJson } from './registry.mjs';

/** Writes the check record, never replacing one that already says another
 *  repository's commit of the same hash was listed (forks share hashes). */
function recordCheck(root, { repository, commit, outcome, reason }, at) {
  const path = checkPath(commit);
  const held = readJson(root, path);
  if (held !== null && held.outcome === 'listed' && (held.repository !== repository || outcome !== 'listed')) return null;
  writeJson(root, path, { repository, commitHash: commit, outcome, reason, checkedAt: at });
  return path;
}

/** Why a verdict cannot be written, or null. A verdict is data from the
 *  check, so nothing in it names a path until it is known to be an id or a
 *  hash. */
export function verdictProblem(verdict) {
  if (typeof verdict !== 'object' || verdict === null) return 'the verdict is not an object';
  if (verdict.outcome === 'rejected' || verdict.outcome === 'unavailable') return null;
  if (idProblem(verdict.id) !== null || gitHubPartsOf(verdict.id) === null) return `the verdict names no Application id it can write: ${verdict.id}`;
  if (verdict.outcome === 'unpublished') return null;
  if (!isCommitHash(verdict.commit)) return `the verdict names no commit hash: ${verdict.commit}`;
  if (!isArchiveSha256(verdict.archiveSha256)) return `the verdict names no source archive SHA-256: ${verdict.archiveSha256}`;
  if (typeof verdict.repository !== 'string' || typeof verdict.cloneUrl !== 'string' || !Number.isInteger(verdict.repositoryId) || !Array.isArray(verdict.flags) || typeof verdict.contributions !== 'object') return 'the verdict is not a listing';
  return null;
}

/** Applies the verdict; answers the paths it wrote. */
export function recordVerdict(root, verdict, at) {
  const problem = verdictProblem(verdict);
  if (problem !== null) throw new Error(problem);
  const written = [];
  if (verdict.outcome === 'unavailable') return written;
  if (verdict.outcome === 'rejected') {
    if (isCommitHash(verdict.commit) && typeof verdict.repository === 'string' && verdict.repository !== '') {
      const path = recordCheck(root, { repository: verdict.repository, commit: verdict.commit, outcome: 'rejected', reason: verdict.reason }, at);
      if (path !== null) written.push(path);
    }
    return written;
  }
  const path = applicationPath(verdict.id);
  if (verdict.outcome === 'unpublished') {
    const file = readJson(root, path);
    writeJson(root, path, { ...file, unpublished: true });
    written.push(path);
  } else if (verdict.outcome === 'listed') {
    const file = readJson(root, path) ?? { id: verdict.id, repository: verdict.cloneUrl, repositoryId: verdict.repositoryId, unpublished: false, releases: [] };
    const releases = file.releases ?? [];
    const relisted = releases.length > 0 && releases[releases.length - 1].hash === verdict.commit;
    const next = relisted ? releases : [...releases, {
      hash: verdict.commit,
      archiveSha256: verdict.archiveSha256,
      listedAt: at,
      flags: verdict.flags,
      platformBuild: platformBuildAt(root, at),
      contributions: verdict.contributions,
    }];
    writeJson(root, path, { id: verdict.id, repository: verdict.cloneUrl, repositoryId: file.repositoryId ?? verdict.repositoryId, unpublished: false, releases: next });
    written.push(path);
    const checked = recordCheck(root, { repository: verdict.repository, commit: verdict.commit, outcome: 'listed', reason: '' }, at);
    if (checked !== null) written.push(checked);
  } else {
    throw new Error(`no verdict ${verdict.outcome} is recorded`);
  }
  writeJson(root, INDEX, indexOf(root));
  written.push(INDEX);
  return written;
}

export const isRegistryRoot = (root) => existsSync(join(root, INDEX)) && existsSync(join(root, 'blocklist.json'));

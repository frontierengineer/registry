// A Release's source archive: the gzipped tar GitHub serves for its commit at
// https://codeload.github.com/<owner>/<name>/tar.gz/<commit>, which is what
// Frontier's Host downloads to install the Release. The Registry records the
// SHA-256 of its bytes with the Release, as `archiveSha256`, and the Host
// refuses an archive that hashes otherwise.
//
// The archive is downloaded twice and both downloads must hash alike, so an
// archive GitHub does not serve byte for byte the same is never recorded.

import { createHash } from 'node:crypto';
import { gitHubPartsOf } from './identity.mjs';
import { applicationFiles, applicationPath, writeJson } from './registry.mjs';

export const CODELOAD = 'https://codeload.github.com/';
const SHA256 = /^[0-9a-f]{64}$/;

export const isArchiveSha256 = (value) => typeof value === 'string' && SHA256.test(value);

/** Where GitHub serves a commit's source archive. */
export const archiveUrlOf = ({ owner, name }, commit, base = CODELOAD) => `${base}${owner}/${name}/tar.gz/${commit}`;

/** The live download: { kind: 'downloaded', bytes } | { kind: 'failed', reason }. */
export async function liveArchive(url) {
  let response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': 'frontier-registry-pipeline' }, redirect: 'follow' });
  } catch (failure) {
    return { kind: 'failed', reason: `${url} cannot be reached: ${failure.message}` };
  }
  if (!response.ok) return { kind: 'failed', reason: `${url} answered ${response.status}` };
  return { kind: 'downloaded', bytes: new Uint8Array(await response.arrayBuffer()) };
}

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The SHA-256 of an id's source archive at the commit, downloaded twice:
 *  { sha256 } | { problem }. */
export async function archiveSha256Of(id, commit, archiveFor = liveArchive) {
  const parts = gitHubPartsOf(id);
  if (parts === null) return { problem: `${id} is not a GitHub repository, so it has no source archive` };
  const url = archiveUrlOf(parts, commit);
  const hashes = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const got = await archiveFor(url);
    if (got.kind !== 'downloaded') return { problem: `the source archive of ${commit} cannot be downloaded: ${got.reason}` };
    if (got.bytes.length === 0) return { problem: `the source archive of ${commit} at ${url} is empty` };
    hashes.push(sha256Of(got.bytes));
  }
  if (hashes[0] !== hashes[1]) return { problem: `GitHub served two different source archives of ${commit} at ${url} (${hashes[0]}, then ${hashes[1]}), so none can be pinned` };
  return { sha256: hashes[0] };
}

/** The Release with its archive's hash placed right after its commit hash. */
export const withArchive = (release, sha256) => {
  const { hash, archiveSha256: _old, ...rest } = release;
  return { hash, archiveSha256: sha256, ...rest };
};

/** Records `archiveSha256` on every Release of every Application file that
 *  lacks one, downloading each archive; a Release that has one is left as it
 *  is. Answers what it recorded, the paths it wrote, and every Release it
 *  could not, each with why. */
export async function backfillArchives(root, archiveFor = liveArchive) {
  const recorded = [];
  const problems = [];
  const written = [];
  for (const file of applicationFiles(root)) {
    let changed = false;
    const releases = [];
    for (const release of file.releases ?? []) {
      if (isArchiveSha256(release.archiveSha256)) { releases.push(release); continue; }
      const hashed = await archiveSha256Of(file.id, release.hash, archiveFor);
      if (hashed.problem !== undefined) {
        problems.push({ id: file.id, hash: release.hash, problem: hashed.problem });
        releases.push(release);
        continue;
      }
      releases.push(withArchive(release, hashed.sha256));
      recorded.push({ id: file.id, hash: release.hash, archiveSha256: hashed.sha256 });
      changed = true;
    }
    if (!changed) continue;
    const path = applicationPath(file.id);
    writeJson(root, path, { ...file, releases });
    written.push(path);
  }
  return { recorded, problems, written };
}

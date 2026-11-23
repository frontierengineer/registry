// A Release's source digest: what its files are, whatever archive carries
// them. Frontier's Host downloads the gzipped tar GitHub serves for a commit,
// at https://codeload.github.com/<owner>/<name>/tar.gz/<commit>, unpacks it,
// and refuses it unless its files have the digest the Registry recorded with
// the Release as `sourceSha256`. GitHub makes those archives as they are asked
// for and has changed their compression before, so the digest is of the files
// alone, never of the archive's bytes.
//
// The source digest of a tree is the SHA-256 of one record per regular file,
// in the order of their paths compared as UTF-8 bytes: `x` when the file is
// executable or `-` when not, a space, the SHA-256 of its bytes in lower-case
// hex, a space, its path relative to the Application's root with `/` between
// segments and no `.` or empty segment, and a NUL byte. Directories add
// nothing. A tree holding a link, or anything but files and directories, has
// no digest: Frontier installs none. The Application's root is the archive's
// top when `contributions.json` is there, and else its one top-level
// directory, as the Host reads it. Frontier's Host and build compute the same
// digest, each held to the test vector in test/pipeline.test.mjs.

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { gitHubPartsOf } from './identity.mjs';
import { applicationFiles, applicationPath, writeJson } from './registry.mjs';

export const CODELOAD = 'https://codeload.github.com/';
const SHA256 = /^[0-9a-f]{64}$/;
const BLOCK = 512;
const EXECUTABLE = 0o111;
const FILE_TYPES = new Set(['0', '\0', '7']);

export const isSourceSha256 = (value) => typeof value === 'string' && SHA256.test(value);

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

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The source digest of files given as { path, executable, bytes }, in any order. */
export function sourceDigestOf(files) {
  const records = files.map((file) => ({ ...file, key: Buffer.from(file.path, 'utf8') })).sort((one, other) => Buffer.compare(one.key, other.key));
  const digest = createHash('sha256');
  for (const { executable, bytes, key } of records) {
    digest.update(`${executable ? 'x' : '-'} ${sha256Hex(bytes)} `);
    digest.update(key);
    digest.update(Buffer.from([0]));
  }
  return digest.digest('hex');
}

const textOf = (bytes) => {
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString('utf8');
};
const octalOf = (bytes) => {
  const digits = textOf(bytes).trim();
  return digits === '' ? 0 : /^[0-7]+$/.test(digits) ? parseInt(digits, 8) : null;
};
const paxValueOf = (bytes, key) => {
  for (const record of Buffer.from(bytes).toString('utf8').split('\n')) {
    const space = record.indexOf(' ');
    const equals = record.indexOf('=');
    if (space !== -1 && equals !== -1 && record.slice(space + 1, equals) === key) return record.slice(equals + 1);
  }
  return null;
};

/** The files of a gzipped tar, as the Host unpacks it: { files } | { problem }. */
export function filesOfArchive(archive) {
  let tar;
  try {
    tar = gunzipSync(archive);
  } catch (failure) {
    return { problem: `it is not gzipped: ${failure.message}` };
  }
  const entries = [];
  let pending = null;
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octalOf(header.subarray(124, 136));
    if (size === null) return { problem: 'it is not a tar archive' };
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length < size) return { problem: 'it ends in the middle of an entry' };
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    const type = String.fromCharCode(header[156]);
    if (type === 'L') { pending = textOf(data); continue; }
    if (type === 'x') { pending = paxValueOf(data, 'path') ?? pending; continue; }
    if (type === 'g') continue;
    const prefix = textOf(header.subarray(257, 262)) === 'ustar' ? textOf(header.subarray(345, 500)) : '';
    const ownName = textOf(header.subarray(0, 100));
    const name = pending ?? (prefix === '' ? ownName : `${prefix}/${ownName}`);
    pending = null;
    if (type === '1' || type === '2') return { problem: `its entry ${name} is a link, and Frontier installs no link` };
    if (!FILE_TYPES.has(type) && type !== '5') return { problem: `its entry ${name} is not a file or a directory` };
    const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (name.startsWith('/') || segments.includes('..')) return { problem: `its entry ${name} is outside the Application's directory` };
    if (segments.length === 0) continue;
    entries.push({ segments, directory: type === '5', executable: ((octalOf(header.subarray(100, 108)) ?? 0) & EXECUTABLE) !== 0, bytes: data });
  }
  const atTop = entries.some((entry) => !entry.directory && entry.segments.length === 1 && entry.segments[0] === 'contributions.json');
  const tops = new Set(entries.map((entry) => entry.segments[0]));
  const [only] = tops;
  const oneDirectory = tops.size === 1 && entries.some((entry) => entry.segments.length > 1 || (entry.directory && entry.segments[0] === only));
  const strip = !atTop && oneDirectory ? 1 : 0;
  const files = new Map();
  for (const entry of entries) {
    if (entry.directory || entry.segments.length <= strip) continue;
    const path = entry.segments.slice(strip).join('/');
    files.set(path, { path, executable: entry.executable, bytes: entry.bytes });
  }
  return { files: [...files.values()] };
}

/** The source digest of an id's commit, its archive downloaded from GitHub:
 *  { sha256 } | { problem, refused }, `refused` when the archive was
 *  downloaded and holds what Frontier does not install. */
export async function sourceSha256Of(id, commit, archiveFor = liveArchive) {
  const parts = gitHubPartsOf(id);
  if (parts === null) return { problem: `${id} is not a GitHub repository, so it has no source archive`, refused: true };
  const url = archiveUrlOf(parts, commit);
  const got = await archiveFor(url);
  if (got.kind !== 'downloaded') return { problem: `the source archive of ${commit} cannot be downloaded: ${got.reason}`, refused: false };
  const read = filesOfArchive(got.bytes);
  if (read.problem !== undefined) return { problem: `the source archive of ${commit} at ${url} cannot be installed as Frontier reads it: ${read.problem}`, refused: true };
  return { sha256: sourceDigestOf(read.files) };
}

/** The Release with its source digest placed right after its commit hash. */
export const withSource = (release, sha256) => {
  const { hash, sourceSha256: _old, archiveSha256: _dropped, ...rest } = release;
  return { hash, sourceSha256: sha256, ...rest };
};

/** Records `sourceSha256` on every Release of every Application file that
 *  lacks one, downloading each archive; a Release that has one is left as it
 *  is. Answers what it recorded, the paths it wrote, and every Release it
 *  could not, each with why. */
export async function backfillSources(root, archiveFor = liveArchive) {
  const recorded = [];
  const problems = [];
  const written = [];
  for (const file of applicationFiles(root)) {
    let changed = false;
    const releases = [];
    for (const release of file.releases ?? []) {
      if (isSourceSha256(release.sourceSha256)) { releases.push(release); continue; }
      const digested = await sourceSha256Of(file.id, release.hash, archiveFor);
      if (digested.problem !== undefined) {
        problems.push({ id: file.id, hash: release.hash, problem: digested.problem });
        releases.push(release);
        continue;
      }
      releases.push(withSource(release, digested.sha256));
      recorded.push({ id: file.id, hash: release.hash, sourceSha256: digested.sha256 });
      changed = true;
    }
    if (!changed) continue;
    const path = applicationPath(file.id);
    writeJson(root, path, { ...file, releases });
    written.push(path);
  }
  return { recorded, problems, written };
}

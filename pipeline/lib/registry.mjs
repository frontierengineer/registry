// The Registry's published files, as Frontier's Host reads them
// (containers/host/modules/registry/interface.ts):
//
//   index.json                 { report, applications: [{ id, title, description, color, latest: { hash, listedAt, flags } }] }
//                              only what Browse shows and filters on, so every Host can download it
//                              to browse however many Applications are listed; what a Release
//                              contributes is in applications/<id>.json, read when it is needed.
//                              report is where an install reports an Application: the issue form,
//                              prefilled by ?application=<id>&release=<hash>; kept by hand, never rebuilt
//   applications/<id>.json     { id, repository, repositoryId, unpublished, releases: Release[] }   oldest first, never emptied;
//                              repositoryId is GitHub's numeric id, which the Host does not read
//   blocklist.json             { applications: [{ id, reason }], releases: [{ id, hash, reason }], publishers: [{ publisher, reason }] }
//   checks/<commit hash>.json  { repository, commitHash, outcome: listed|rejected|pending, reason, checkedAt }
//   platform.json              { builds: [{ buildId, publishedAt }] }
//
//   Release = { hash, listedAt, flags: string[], platformBuild, contributions }
//
// and the listings publishers add by pull request, which the Host never reads:
//
//   listings/<id>.json         { id, repository, commit }

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const listingPath = (id) => `listings/${id}.json`;
export const applicationPath = (id) => `applications/${id}.json`;
export const checkPath = (hash) => `checks/${hash.toLowerCase()}.json`;
export const INDEX = 'index.json';
export const BLOCKLIST = 'blocklist.json';
export const PLATFORM = 'platform.json';

export function readJson(root, path, otherwise = null) {
  const full = join(root, path);
  if (!existsSync(full)) return otherwise;
  return JSON.parse(readFileSync(full, 'utf8'));
}

export function writeJson(root, path, value) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonFilesUnder(root, directory) {
  const base = join(root, directory);
  if (!existsSync(base)) return [];
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(relative(root, path));
    }
  };
  walk(base);
  return found.sort();
}

/** Every Application file, listed now or unpublished. */
export const applicationFiles = (root) => jsonFilesUnder(root, 'applications').map((path) => readJson(root, path));

export const readBlocklist = (root) => {
  const value = readJson(root, BLOCKLIST, {});
  return { applications: value.applications ?? [], releases: value.releases ?? [], publishers: value.publishers ?? [] };
};

/** The newest Platform build published by the moment, or ''. */
export function platformBuildAt(root, moment) {
  const builds = readJson(root, PLATFORM, { builds: [] }).builds ?? [];
  const before = builds.filter(({ publishedAt }) => publishedAt <= moment).sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1));
  return before.length === 0 ? '' : before[before.length - 1].buildId;
}

/** The blocklist's reason for an id, a Release of it or its publisher, as
 *  the Host matches them (case ignored), or ''. */
export function blocklistReason(blocklist, id, hash) {
  const lower = id.toLowerCase();
  const byId = blocklist.applications.find((entry) => entry.id.toLowerCase() === lower);
  if (byId) return byId.reason || 'the Registry blocklists it';
  const byRelease = blocklist.releases.find((entry) => entry.id.toLowerCase() === lower && entry.hash.toLowerCase() === hash.toLowerCase());
  if (byRelease) return byRelease.reason || 'the Registry blocklists this Release';
  const publisher = lower.split('/').slice(0, -1).join('/');
  const byPublisher = blocklist.publishers.find((entry) => entry.publisher.toLowerCase() === publisher);
  return byPublisher ? byPublisher.reason || 'the Registry blocklists its publisher' : '';
}

/** index.json, from every Application file not unpublished: each at its
 *  latest Release, ordered by id, holding only what Browse shows and filters
 *  on. Every other top-level field the index holds, such as `report`, is a
 *  maintainer's and kept as it is. */
export function indexOf(root) {
  const { applications: _rebuilt, ...kept } = readJson(root, INDEX, {}) ?? {};
  const applications = applicationFiles(root)
    .filter((file) => file.unpublished !== true && file.releases.length > 0)
    .map((file) => {
      const { hash, listedAt, flags, contributions } = file.releases[file.releases.length - 1];
      const declared = contributions ?? {};
      return {
        id: file.id,
        title: typeof declared.title === 'string' ? declared.title : file.id,
        description: typeof declared.description === 'string' ? declared.description : '',
        color: typeof declared.color === 'string' ? declared.color : '',
        latest: { hash, listedAt, flags },
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...kept, applications };
}

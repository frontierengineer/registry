#!/usr/bin/env node
// Reads a pull request's change out of a Registry checkout that has fetched
// its head, as data: which files it changes against where it branched from
// the base, and the listing file's content at its head. Nothing of the pull
// request is checked out or run.
//
//   node bin/pull-request.mjs --repository <Registry checkout> --base <base ref> --head <head commit>
//                             --changes <changes file to write> --listing <listing file to write>
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { listingChangeOf } from '../lib/check.mjs';

const { values } = parseArgs({ options: { repository: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, changes: { type: 'string' }, listing: { type: 'string' } } });
for (const name of ['repository', 'base', 'head', 'changes', 'listing']) {
  if (!values[name]) { console.error(`--${name} is needed`); process.exit(2); }
}
const git = (args) => {
  const ran = spawnSync('git', args, { cwd: values.repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (ran.status !== 0) { console.error(`git ${args[0]} failed: ${ran.stderr}`); process.exit(1); }
  return ran.stdout;
};
const forkPoint = git(['merge-base', values.base, values.head]).trim();
const fields = git(['diff', '--name-status', '--no-renames', '-z', forkPoint, values.head]).split('\0').filter((field) => field !== '');
const changes = [];
for (let index = 0; index + 1 < fields.length; index += 2) changes.push({ status: fields[index].slice(0, 1), path: fields[index + 1] });
writeFileSync(values.changes, `${JSON.stringify(changes, null, 2)}\n`);
const change = listingChangeOf(changes);
writeFileSync(values.listing, change.kind === 'list' ? git(['show', `${values.head}:${change.path}`]) : '');
console.log(change.problem ?? `${change.kind} ${change.id}`);

#!/usr/bin/env node
// Reads a pull request's change through GitHub's API, as data, and asks
// GitHub what the check will need to know about the listed repository and the
// pull request's author. The job that runs this holds the token; the job that
// checks holds none and replays these answers.
//
//   node bin/pull-request.mjs --repository <owner/name of the Registry> --number <n> --head <head commit>
//                             --author <login> --out <directory to write changes.json, listing.json, answers.json>
//
// GITHUB_TOKEN reads public data at a higher rate limit; GITHUB_API_URL
// points it elsewhere.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { askGitHub } from '../lib/listing.mjs';
import { liveGitHub, recordingGitHub } from '../lib/github.mjs';
import { readPullRequest } from '../lib/pull-request.mjs';

const { values } = parseArgs({ options: { repository: { type: 'string' }, number: { type: 'string' }, head: { type: 'string' }, author: { type: 'string' }, out: { type: 'string' } } });
for (const name of ['repository', 'number', 'head', 'author', 'out']) {
  if (!values[name]) { console.error(`--${name} is needed`); process.exit(2); }
}
const token = process.env.GITHUB_TOKEN ?? '';
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const { changes, listingText } = await readPullRequest({ repository: values.repository, number: values.number, head: values.head, token, api });
const github = recordingGitHub(liveGitHub(token, api));
await askGitHub({ changes, listingText, author: values.author, github });
writeFileSync(join(values.out, 'changes.json'), `${JSON.stringify(changes, null, 2)}\n`);
writeFileSync(join(values.out, 'listing.json'), listingText ?? '');
writeFileSync(join(values.out, 'answers.json'), `${JSON.stringify(github.answers, null, 2)}\n`);
console.log(changes.map(({ status, path }) => `${status} ${path}`).join('\n'));

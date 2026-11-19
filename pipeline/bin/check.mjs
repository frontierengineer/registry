#!/usr/bin/env node
// Checks one listing pull request and writes its verdict as JSON.
//
//   node bin/check.mjs --root <registry checkout at the base branch>
//                      --changes <JSON file: [{ "status": "A|M|D|R", "path": "..." }]>
//                      --listing <the listing file at the pull request's head; omitted when it is removed>
//                      --author <login that opened the pull request>
//                      [--answers <GitHub's answers, from bin/pull-request.mjs>]
//                      --out <verdict file>
//
// With --answers it asks GitHub nothing, and holds no token; without it, it
// asks GitHub itself (GITHUB_TOKEN, when set, only raises the rate limit).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkListing } from '../lib/check.mjs';
import { liveGitHub, replayedGitHub } from '../lib/github.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, changes: { type: 'string' }, listing: { type: 'string' }, author: { type: 'string' }, answers: { type: 'string' }, out: { type: 'string' } } });
for (const name of ['root', 'changes', 'author', 'out']) {
  if (!values[name]) { console.error(`--${name} is needed`); process.exit(2); }
}
const verdict = await checkListing({
  root: values.root,
  changes: JSON.parse(readFileSync(values.changes, 'utf8')),
  listingText: values.listing ? readFileSync(values.listing, 'utf8') : null,
  author: values.author,
  github: values.answers ? replayedGitHub(JSON.parse(readFileSync(values.answers, 'utf8'))) : liveGitHub(),
});
writeFileSync(values.out, `${JSON.stringify(verdict, null, 2)}\n`);
console.log(`${verdict.outcome}${verdict.reason ? `: ${verdict.reason}` : ''}`);

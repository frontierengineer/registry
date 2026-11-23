#!/usr/bin/env node
// Records the source digest on every Release listed before the pipeline
// recorded one, downloading each commit's archive from GitHub, and prints a
// JSON line for each Release it recorded and each it could not.
//
//   node bin/backfill-sources.mjs --root <registry checkout at the default branch>
//
// A Release that holds `sourceSha256` already is left as it is, so running it
// again records nothing. It exits 1 when any Release could not be recorded.
import { parseArgs } from 'node:util';
import { backfillSources } from '../lib/source.mjs';
import { isRegistryRoot } from '../lib/record.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
if (!values.root) { console.error('--root is needed'); process.exit(2); }
if (!isRegistryRoot(values.root)) { console.error(`${values.root} holds no Registry (no index.json and blocklist.json)`); process.exit(2); }
const { recorded, problems } = await backfillSources(values.root);
for (const each of recorded) console.log(JSON.stringify(each));
for (const each of problems) console.error(JSON.stringify(each));
process.exit(problems.length === 0 ? 0 : 1);

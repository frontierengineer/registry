#!/usr/bin/env node
// Writes a verdict into the Registry's files and prints each path written.
//
//   node bin/record.mjs --root <registry checkout at the default branch> --verdict <verdict file> [--at <ISO-8601 UTC>]
//
// --at defaults to now: the Release's time is when the Registry lists it.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isRegistryRoot, recordVerdict } from '../lib/record.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, verdict: { type: 'string' }, at: { type: 'string' } } });
if (!values.root || !values.verdict) { console.error('--root and --verdict are needed'); process.exit(2); }
if (!isRegistryRoot(values.root)) { console.error(`${values.root} holds no Registry (no index.json and blocklist.json)`); process.exit(2); }
const at = values.at ?? new Date().toISOString();
for (const path of recordVerdict(values.root, JSON.parse(readFileSync(values.verdict, 'utf8')), at)) console.log(path);

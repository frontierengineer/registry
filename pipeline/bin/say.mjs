#!/usr/bin/env node
// The pull request comment for a verdict, in Markdown, on standard output.
//
//   node bin/say.mjs --verdict <verdict file> [--commit <the Registry commit that listed it>]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { verdict: { type: 'string' }, commit: { type: 'string' } } });
const verdict = JSON.parse(readFileSync(values.verdict, 'utf8'));
const lines = [];
if (verdict.outcome === 'listed') {
  lines.push(`Listed **${verdict.id}** at \`${verdict.commit}\`.`);
  lines.push('', verdict.flags.length === 0 ? 'The scan raised no flags.' : `The scan flags it, and the install prompt shows each flag: ${verdict.flags.map((flag) => `*${flag}*`).join(', ')}.`);
  if (values.commit) lines.push('', `Recorded in ${values.commit}. Hosts see it within ten minutes, as GitHub and each Host refresh what they hold.`);
} else if (verdict.outcome === 'unpublished') {
  lines.push(`Unpublished **${verdict.id}**: it leaves Browse and new installs. Every Release it had stays recorded, so installs that run one keep it.`);
} else if (verdict.outcome === 'rejected') {
  lines.push(`Not listed${verdict.id ? ` **${verdict.id}**` : ''}${verdict.commit ? ` at \`${verdict.commit}\`` : ''}: ${verdict.reason}`);
  lines.push('', 'Fix it, push the fix and open the listing pull request again with the new commit. Nobody reviews a listing by hand, so this reason is the whole of the decision.');
} else {
  lines.push(`The check could not finish: ${verdict.reason}. It runs again when the pull request is reopened or its listing changes.`);
}
console.log(lines.join('\n'));

// "The Registry MUST refuse to list a name within typosquatting distance of a
// listed one." Two ids are within that distance when, compared without their
// host (`github.com/`) and case:
//   - their folded forms are equal, folding the characters that read alike
//     (0 o, 1 l i, 5 s, rn m, vv w) and dropping `-`, `_` and `.`; or
//   - one is a single edit from the other (an insertion, a deletion, a
//     substitution, or two neighbours swapped).
// Ids of the same owner never conflict: an owner cannot squat on itself, and
// `acme/notes` beside `acme/note` is the owner's own choice.

import { gitHubPartsOf } from './identity.mjs';

const CONFUSABLE = [[/rn/g, 'm'], [/vv/g, 'w'], [/[0]/g, 'o'], [/[1il|]/g, 'l'], [/[5]/g, 's']];

export function folded(text) {
  let out = text.toLowerCase().replace(/[-_.]/g, '');
  for (const [pattern, replacement] of CONFUSABLE) out = out.replace(pattern, replacement);
  return out;
}

/** Optimal string alignment distance, which counts a swap of neighbours as
 *  one edit. */
export function editDistance(a, b) {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const d = Array.from({ length: rows }, () => new Array(columns).fill(0));
  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < columns; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const pathOf = ({ owner, name }) => `${owner}/${name}`.toLowerCase();

/** The listed id the candidate is within typosquatting distance of, or null. */
export function squattedOn(candidate, listedIds) {
  const mine = gitHubPartsOf(candidate);
  if (mine === null) return null;
  const path = pathOf(mine);
  const fold = folded(path);
  for (const listed of listedIds) {
    const theirs = gitHubPartsOf(listed);
    if (theirs === null || theirs.owner.toLowerCase() === mine.owner.toLowerCase()) continue;
    const other = pathOf(theirs);
    if (folded(other) === fold || editDistance(path, other) <= 1) return listed;
  }
  return null;
}

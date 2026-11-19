// The scan every Release passes before it is listed. What it refuses stops
// the listing, with the reason; what it flags is listed anyway and recorded on
// the Release in these words, which the install prompt shows a person.

export const SIZE_LIMIT_BYTES = 25 * 1024 * 1024;
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;

const SECRETS = [
  ['a private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ['an OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a Stripe secret key', /\b[rs]k_live_[0-9a-zA-Z]{24,}\b/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
];

/** The first secret found in the files, as `<what> in <path>`, or null. Each
 *  file is { path, text }. */
export function secretIn(files) {
  for (const { path, text } of files) {
    if (text.length > TEXT_LIMIT_BYTES) continue;
    for (const [what, pattern] of SECRETS) if (pattern.test(text)) return `${what} in ${path}`;
  }
  return null;
}

/** Why the packages an Application uses are not as the Platform installs
 *  them, or null: `package.json` comes with `package-lock.json` or not at
 *  all, and every package comes from the npm registry as the lock records it. */
export function packagesProblem(packageJson, packageLock) {
  if (packageJson === null) return packageLock === null ? null : 'package-lock.json is there without package.json';
  if (packageLock === null) return 'package.json is there without package-lock.json, and the Platform installs exactly what the lock file records';
  let lock;
  try {
    lock = JSON.parse(packageLock);
  } catch (failure) {
    return `package-lock.json is not JSON: ${failure.message}`;
  }
  if (typeof lock !== 'object' || lock === null || typeof lock.packages !== 'object' || lock.packages === null) return 'package-lock.json records no packages; write it with npm 7 or later';
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry === null || typeof entry !== 'object' || entry.link === true) continue;
    if (!path.includes('node_modules/')) continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(NPM_REGISTRY)) {
      return `${path.replace(/^.*node_modules\//, '')} is not from the npm registry (${entry.resolved ?? 'no resolved URL'}), and an Application's packages come only from there`;
    }
    if (typeof entry.integrity !== 'string' || entry.integrity === '') return `${path.replace(/^.*node_modules\//, '')} has no integrity in package-lock.json`;
  }
  return null;
}

// Flags are read from the built Bundles, which hold the Application's code
// and every package it uses, exactly what runs. A Node built-in stays an
// import by name in a host or worker Bundle, so it is seen as one.
const FLAGS = [
  ['reaches the network', [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bnew\s+WebSocket\b/, /\bEventSource\b/, /["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns)["']/]],
  ['starts processes', [/["'](?:node:)?(?:child_process|cluster|worker_threads)["']/]],
  ['reads or writes files', [/["'](?:node:)?fs(?:\/promises)?["']/]],
  ['runs code it builds at run time', [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /["'](?:node:)?vm["']/]],
  ['holds encoded data it may run', [/["'`][A-Za-z0-9+/]{400,}={0,2}["'`]/, /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){60,}/i]],
];

/** The flags the Bundles raise, in the Registry's words, each once, in a
 *  fixed order. */
export function flagsOf(bundles) {
  const code = bundles.join('\n');
  return FLAGS.filter(([, patterns]) => patterns.some((pattern) => pattern.test(code))).map(([flag]) => flag);
}

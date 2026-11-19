// The Application built as Frontier's Host builds it
// (containers/host/modules/esbuild): each of host, worker and surface that has
// an entry file (`.ts`, then `.tsx`) bundled by esbuild into one ES module,
// with translations.json carried in, never type-checked. The packages are
// installed first with `npm ci`, as the Host does, but with install scripts
// off: the pipeline never runs a publisher's code.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const KINDS = ['host', 'worker', 'surface'];
const EXTENSIONS = ['.ts', '.tsx'];
const INLINED = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf'];
const REQUIRE_FOR_COMMONJS_PACKAGES = "import { createRequire as __frontierCreateRequire } from 'node:module'; const require = __frontierCreateRequire(import.meta.url);";
const SHOWN_ERRORS = 10;

const entryText = (entry, translations) => `export * from './${entry}';\nexport const translations = ${translations};\n`;

function optionsFor(kind, sourcePath, text) {
  const common = {
    absWorkingDir: sourcePath,
    stdin: { contents: text, resolveDir: sourcePath, sourcefile: `frontier-entry-${kind}.ts`, loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    outdir: join(sourcePath, '.frontier-bundle'),
    logLevel: 'silent',
    charset: 'utf8',
    legalComments: 'none',
  };
  if (kind === 'surface') return { ...common, platform: 'browser', target: 'es2022', loader: Object.fromEntries(INLINED.map((extension) => [extension, 'dataurl'])) };
  return { ...common, platform: 'node', target: 'node20', banner: { js: REQUIRE_FOR_COMMONJS_PACKAGES } };
}

function translationsOf(sourcePath) {
  const path = join(sourcePath, 'translations.json');
  if (!existsSync(path)) return { text: '{}' };
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (failure) {
    return { problem: `translations.json is not JSON: ${failure.message}` };
  }
  const isTexts = (texts) => typeof texts === 'object' && texts !== null && !Array.isArray(texts) && Object.values(texts).every((text) => typeof text === 'string');
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.values(value).every(isTexts)) {
    return { problem: 'translations.json is not an object of languages, each an object of tokens to text' };
  }
  const tokens = [...new Set(Object.values(value).flatMap((texts) => Object.keys(texts)))];
  for (const [language, texts] of Object.entries(value)) {
    const missing = tokens.find((token) => !Object.hasOwn(texts, token));
    if (missing !== undefined) return { problem: `translations.json: the token "${missing}" is missing from the language "${language}", which other languages have` };
  }
  return { text: JSON.stringify(value) };
}

const located = (message) => (message.location ? `${message.location.file}:${message.location.line}:${message.location.column}: ${message.text}` : message.text);

/** Installs the packages and builds every Bundle. Answers { bundles } (the
 *  JavaScript of each, for the scan) or { problem } in the compiler's words. */
export async function buildApplication(sourcePath) {
  if (existsSync(join(sourcePath, 'package.json'))) {
    const installed = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: sourcePath, encoding: 'utf8', env: { ...process.env, npm_config_ignore_scripts: 'true' } });
    if (installed.status !== 0) return { problem: `npm ci failed: ${(installed.stderr || installed.stdout || '').trim().split('\n').slice(0, SHOWN_ERRORS).join(' ')}` };
  }
  const translations = translationsOf(sourcePath);
  if (translations.problem !== undefined) return { problem: translations.problem };
  const bundles = [];
  const errors = [];
  for (const kind of KINDS) {
    const entry = EXTENSIONS.map((extension) => `${kind}${extension}`).find((name) => existsSync(join(sourcePath, name)));
    if (entry === undefined) continue;
    try {
      const built = await esbuild.build(optionsFor(kind, sourcePath, entryText(entry, translations.text)));
      const code = built.outputFiles.find(({ path }) => path.endsWith('.js'));
      if (code !== undefined) bundles.push(code.text);
    } catch (failure) {
      const reported = Array.isArray(failure.errors) ? failure.errors.map(located) : [String(failure.message ?? failure)];
      errors.push(...reported.map((text) => `${entry}: ${text}`));
    }
  }
  await esbuild.stop();
  if (errors.length > 0) return { problem: `it does not build: ${errors.slice(0, SHOWN_ERRORS).join('; ')}` };
  return { bundles };
}

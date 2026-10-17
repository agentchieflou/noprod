// Enforces CLAUDE.md's "Dependencies: we own what we ship".
//
//   node scripts/check-licenses.mjs
//
// Needs `npm ci` first: most lockfile entries carry no license, so licenses
// are read from node_modules. Fails on:
//   - a shipped package (reachable through production dependencies) whose
//     license isn't on the allowlist;
//   - a vendored directory under apps/audio_core/third_party that
//     THIRD_PARTY.md doesn't list.
// Dev tooling (the e2e runner, linters, types) is reported, never failed.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED = new Set([
  'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', 'Zlib', '0BSD',
  'MIT-0', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0',
]);

// Temporary: each rebuild PR deletes its entry.
//   - Strudel (AGPL) under apps/sequencer: #133
//   - the JUCE submodule: #134
const EXCEPTIONS = [
  { pkg: /^(@strudel|@kabelsalat)\/|^(superdough|supradough|hydra-synth)$/, why: 'Strudel and its AGPL dependencies; replaced by our own pattern engine (#133)' },
];
const SUBMODULE_EXCEPTIONS = [
  { path: 'apps/audio_core/JUCE', why: 'JUCE is paid/GPL; GhostDAW is rebuilt without it (#134)' },
];

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const pkgs = lock.packages;

function licenseOf(loc) {
  const file = join(root, loc, 'package.json');
  // Optional native binaries for other platforms aren't installed
  if (!existsSync(file)) return 'NOT INSTALLED (other platform)';
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  let l = meta.license ?? pkgs[loc].license;
  if (l && typeof l === 'object') l = l.type;
  if (!l && Array.isArray(meta.licenses)) l = meta.licenses.map((x) => x.type ?? x).join(' OR ');
  return l ?? 'UNKNOWN';
}

// An SPDX expression passes if each AND group has an allowed alternative.
function allowed(expr) {
  const toks = expr.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  const ors = expr.split(/\s+OR\s+/i);
  return ors.some((alt) => alt.replace(/[()]/g, ' ').split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

// Where `name` resolves from the package at `from`, the way node does
function resolveDep(from, name) {
  let dir = from;
  for (;;) {
    const loc = `${dir ? dir + '/' : ''}node_modules/${name}`;
    if (pkgs[loc]) return loc;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i < 0 ? '' : dir.slice(0, i);
  }
}

// Every location reachable from the workspaces, with the path that got there
function walk(include) {
  const seen = new Map();
  const queue = Object.entries(pkgs)
    .filter(([loc, p]) => loc === '' || (!loc.includes('node_modules') && !p.link))
    .map(([loc]) => [loc, [loc || 'root']]);
  while (queue.length) {
    const [loc, path] = queue.shift();
    const p = pkgs[loc];
    for (const name of Object.keys(include(loc, p))) {
      const dep = resolveDep(loc, name);
      if (!dep || seen.has(dep)) continue;
      const target = pkgs[dep].link ? pkgs[dep].resolved : dep;
      if (seen.has(target)) continue;
      seen.set(target, [...path, name]);
      queue.push([target, [...path, name]]);
    }
  }
  return seen;
}

const nameOf = (loc) => loc.split('node_modules/').pop();
const workspace = (loc) => !loc.includes('node_modules');
const prodDeps = (_, p) => ({ ...p.dependencies, ...p.optionalDependencies });
const allDeps = (_, p) => ({ ...p.dependencies, ...p.optionalDependencies, ...p.devDependencies });

const shipped = new Map([...walk(prodDeps)].filter(([loc]) => !workspace(loc)));
const everything = new Map([...walk(allDeps)].filter(([loc]) => !workspace(loc)));

const failures = [];
const excepted = [];
const note = (map, lic, name) => map.set(lic, [...(map.get(lic) ?? []), name]);
const shippedLicenses = new Map();
const devLicenses = new Map();

for (const [loc, path] of shipped) {
  const lic = licenseOf(loc);
  const name = nameOf(loc);
  note(shippedLicenses, lic, name);
  if (allowed(lic)) continue;
  const ex = EXCEPTIONS.find((e) => e.pkg.test(name));
  if (ex) excepted.push(`${name} (${lic}): ${ex.why}`);
  else failures.push(`${name}@${pkgs[loc].version} is ${lic}: ${path.join(' > ')}`);
}
for (const [loc] of everything) {
  if (shipped.has(loc)) continue;
  note(devLicenses, licenseOf(loc), nameOf(loc));
}

function report(title, map) {
  console.log(`\n${title}`);
  for (const [lic, names] of [...map].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${lic}: ${names.length}${names.length <= 3 ? ` (${names.join(', ')})` : ''}`);
  }
}
report('Shipped dependencies by license', shippedLicenses);
report('Dev tooling by license (reported, not enforced)', devLicenses);

// Vendored native code must be listed in THIRD_PARTY.md
const thirdPartyDir = join(root, 'apps/audio_core/third_party');
const listed = readFileSync(join(root, 'THIRD_PARTY.md'), 'utf8');
for (const d of readdirSync(thirdPartyDir)) {
  if (!statSync(join(thirdPartyDir, d)).isDirectory()) continue;
  if (!listed.includes(`apps/audio_core/third_party/${d}`)) {
    failures.push(`apps/audio_core/third_party/${d} is not listed in THIRD_PARTY.md`);
  }
}

// Submodules are checked out or not depending on the clone; the exceptions
// have to name every one of them
const gm = join(root, '.gitmodules');
if (existsSync(gm)) {
  for (const [, path] of readFileSync(gm, 'utf8').matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
    const ex = SUBMODULE_EXCEPTIONS.find((e) => e.path === path.trim());
    if (ex) excepted.push(`${path.trim()}: ${ex.why}`);
    else failures.push(`submodule ${path.trim()} is not on the exception list`);
  }
}

if (excepted.length) {
  console.log('\nTemporary exceptions in use');
  for (const e of excepted) console.log(`  ${e}`);
}
if (failures.length) {
  console.error('\nLicense check failed:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nLicense check passed.');

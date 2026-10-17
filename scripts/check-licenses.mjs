// Enforces CLAUDE.md's "Dependencies: we own what we ship".
//
//   node scripts/check-licenses.mjs
//
// Needs `npm ci` first: most lockfile entries carry no license, so licenses
// are read from node_modules. Fails on:
//   - a shipped package (reachable through production dependencies) whose
//     license isn't on the allowlist;
//   - a vendored directory under apps/audio_core/third_party, or a git
//     submodule, that THIRD_PARTY.md doesn't list (restricted submodules are
//     exceptions instead).
// Dev tooling (the e2e runner, linters, types) is reported, never failed.
// scripts/check-licenses.test.mjs holds the script's own tests.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set([
  'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', 'Zlib', '0BSD',
  'MIT-0', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0',
]);

// Exceptions: packages a workspace may ship under a restricted license
// (`pkg` matches the name, reached from `only` and from no other
// workspace), and submodules. Each rebuild PR deleted its entry: Strudel
// (#133) and the JUCE submodule (#134) are gone, so both lists are empty.
export const EXCEPTIONS = [];
export const SUBMODULE_EXCEPTIONS = [];

const NOT_INSTALLED = 'NOT INSTALLED (other platform)';

// An SPDX expression: AND binds tighter than OR, parentheses group. Anything
// that doesn't parse, and any `WITH` exception, fails closed.
export function allowed(expr) {
  const toks = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const or = () => {
    let ok = and();
    while (toks[i]?.toUpperCase() === 'OR') { i++; const r = and(); ok = ok || r; }
    return ok;
  };
  const and = () => {
    let ok = atom();
    while (toks[i]?.toUpperCase() === 'AND') { i++; const r = atom(); ok = ok && r; }
    return ok;
  };
  const atom = () => {
    const t = toks[i++];
    if (t === '(') {
      const ok = or();
      if (toks[i++] !== ')') throw new Error('unbalanced');
      return ok;
    }
    if (t === undefined || t === ')' || /^(AND|OR|WITH)$/i.test(t)) throw new Error('unexpected');
    if (toks[i]?.toUpperCase() === 'WITH') { i += 2; return false; }
    return ALLOWED.has(t);
  };
  try {
    const ok = or();
    return i === toks.length && ok;
  } catch {
    return false;
  }
}

// Where `name` resolves from the package at `from`, the way node does
function resolveDep(pkgs, from, name) {
  let dir = from;
  for (;;) {
    const loc = `${dir ? dir + '/' : ''}node_modules/${name}`;
    if (pkgs[loc]) return loc;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i < 0 ? '' : dir.slice(0, i);
  }
}

// Every location reachable from `roots`, with the path that got there
function walk(pkgs, roots, include) {
  const seen = new Map();
  const queue = roots.map((r) => [r, [r || 'root']]);
  while (queue.length) {
    const [loc, path] = queue.shift();
    for (const name of Object.keys(include(pkgs[loc]))) {
      const dep = resolveDep(pkgs, loc, name);
      if (!dep) continue;
      const target = pkgs[dep].link ? pkgs[dep].resolved : dep;
      if (seen.has(target)) continue;
      seen.set(target, [...path, name]);
      queue.push([target, [...path, name]]);
    }
  }
  return seen;
}

const isWorkspace = (loc) => !loc.includes('node_modules');
const nameOf = (loc) => loc.split('node_modules/').pop();
const prodDeps = (p) => ({ ...p.dependencies, ...p.optionalDependencies });
const allDeps = (p) => ({ ...prodDeps(p), ...p.devDependencies });

// `lock` is the parsed package-lock.json; `readMeta(loc)` returns a
// package's package.json (or null if it isn't installed); `thirdPartyDirs`
// are the directories under apps/audio_core/third_party; `thirdPartyMd` is
// THIRD_PARTY.md; `gitmodules` is the .gitmodules text. The tests pass
// exceptions of their own; the real lists are above.
export function check({ lock, readMeta, thirdPartyDirs, thirdPartyMd, gitmodules, exceptions = EXCEPTIONS, submoduleExceptions = SUBMODULE_EXCEPTIONS }) {
  const pkgs = lock.packages;
  const workspaces = Object.keys(pkgs).filter((l) => l && isWorkspace(l) && !pkgs[l].link);

  const licenseOf = (loc) => {
    const meta = readMeta(loc);
    if (!meta) return pkgs[loc].license ?? NOT_INSTALLED;
    let l = meta.license ?? pkgs[loc].license;
    if (l && typeof l === 'object') l = l.type;
    if (!l && Array.isArray(meta.licenses)) l = meta.licenses.map((x) => x.type ?? x).join(' OR ');
    return l ?? 'UNKNOWN';
  };

  // What each workspace ships, on its own
  const reach = new Map(workspaces.map((w) => [w, walk(pkgs, [w], prodDeps)]));
  const shipped = new Map();
  for (const r of reach.values()) for (const [loc, path] of r) if (!shipped.has(loc)) shipped.set(loc, path);
  for (const loc of [...shipped.keys()]) if (isWorkspace(loc)) shipped.delete(loc);

  const failures = [];
  const excepted = [];
  const shippedLicenses = new Map();
  const devLicenses = new Map();
  const note = (map, lic, name) => map.set(lic, [...(map.get(lic) ?? []), name]);

  for (const [loc, path] of shipped) {
    const lic = licenseOf(loc);
    const name = nameOf(loc);
    note(shippedLicenses, lic, name);
    if (allowed(lic)) continue;
    const owners = workspaces.filter((w) => reach.get(w).has(loc));
    const ex = exceptions.find((e) => e.pkg.test(name) && owners.every((w) => w === e.only));
    if (ex) excepted.push(`${name} (${lic}): ${ex.why}`);
    else {
      // Name the path from a workspace the exception doesn't cover
      const bad = owners.find((w) => !exceptions.some((e) => e.pkg.test(name) && e.only === w)) ?? owners[0];
      failures.push(`${name}@${pkgs[loc].version} is ${lic}: ${reach.get(bad).get(loc).join(' > ') || path.join(' > ')}`);
    }
  }

  for (const loc of walk(pkgs, ['', ...workspaces], allDeps).keys()) {
    if (!shipped.has(loc) && !isWorkspace(loc)) note(devLicenses, licenseOf(loc), nameOf(loc));
  }

  // Vendored native code and submodules are listed in THIRD_PARTY.md as
  // `path` cells
  const listed = new Set([...thirdPartyMd.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  for (const d of thirdPartyDirs) {
    if (!listed.has(`apps/audio_core/third_party/${d}`)) {
      failures.push(`apps/audio_core/third_party/${d} is not listed in THIRD_PARTY.md`);
    }
  }
  for (const [, p] of gitmodules.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
    const path = p.trim();
    const ex = submoduleExceptions.find((e) => e.path === path);
    if (ex) excepted.push(`${path}: ${ex.why}`);
    else if (!listed.has(path)) failures.push(`submodule ${path} is neither listed in THIRD_PARTY.md nor an exception`);
  }

  return { failures, excepted, shippedLicenses, devLicenses };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const readMeta = (loc) => {
    const file = join(root, loc, 'package.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const dir = join(root, 'apps/audio_core/third_party');
  const gm = join(root, '.gitmodules');
  const { failures, excepted, shippedLicenses, devLicenses } = check({
    lock,
    readMeta,
    thirdPartyDirs: readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()),
    thirdPartyMd: readFileSync(join(root, 'THIRD_PARTY.md'), 'utf8'),
    gitmodules: existsSync(gm) ? readFileSync(gm, 'utf8') : '',
  });

  const report = (title, map) => {
    console.log(`\n${title}`);
    for (const [lic, names] of [...map].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${lic}: ${names.length}${names.length <= 3 ? ` (${names.join(', ')})` : ''}`);
    }
  };
  report('Shipped dependencies by license', shippedLicenses);
  report('Dev tooling by license (reported, not enforced)', devLicenses);
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

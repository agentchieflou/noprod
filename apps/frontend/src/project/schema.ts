// project.json: its schema, checked on every load, and the migrations that
// bring any earlier version up to the current one (see README.md).

export const FORMAT = 'noprod-project';
export const SCHEMA_VERSION = 2;

export class ProjectFileError extends Error {
  constructor(message: string) { super(message); this.name = 'ProjectFileError'; }
}
const fail = (msg: string): never => { throw new ProjectFileError(msg); };

// How a buffer's samples are stored: entry i of `buffers` is the i-th
// buffer in the file (PCM chunks name it by that index)
export interface BufferInfo {
  id: string;
  sampleRate: number;
  length: number;   // frames
  channels: number;
}

export interface ProjectDoc {
  format: typeof FORMAT;
  version: number;
  savedAt?: string;
  buffers: BufferInfo[];
  // The store's project slice; AudioBuffers appear as { $audioBuffer: id }
  project: Record<string, any>;
}

export const BUFFER_LIMITS = { count: 100_000, channels: 32, minSampleRate: 3000, maxSampleRate: 768000, frames: 2 ** 31 - 1 };

// How many items a list may hold: generous, so no real project reaches them
export const COUNT_LIMITS = {
  tracks: 1000, returns: 64, regions: 100_000, notes: 100_000, devices: 256, takeLanes: 64,
  locators: 10_000, timeSignatures: 10_000, midiMappings: 10_000
};

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- migrations
// MIGRATIONS[n] takes a doc at version n to version n + 1. To change the
// schema: bump SCHEMA_VERSION, add the migration from the old version, and
// update the checks below (the tests hold them to the store's PROJECT_KEYS).

// The project keys v1 files were first written with; later v1 builds added
// the rest, which older v1 files lack and the store filled with defaults
const V1_FIRST_KEYS = ['bpm', 'timeSignatures', 'countInBars', 'masterVolume', 'masterPan', 'returns', 'masterPlugins',
  'isLimiterEnabled', 'isLoopEnabled', 'loopStart', 'loopEnd', 'locators', 'punchInTime', 'punchOutTime', 'isPunchEnabled',
  'vstScanPaths', 'tracks', 'regions', 'sessionClips', 'savedRacks'];

const MIGRATIONS: Record<number, (doc: any, defaults: Record<string, unknown>) => any> = {
  // v2 requires every key; v1 files may predate scenes, launchQuantization
  // and midiMappings
  1: (doc, defaults) => {
    if (!isObject(doc.project)) return { ...doc, version: 2 };
    const added: Record<string, unknown> = {};
    Object.keys(defaults).forEach((k) => { if (!V1_FIRST_KEYS.includes(k) && !(k in doc.project)) added[k] = defaults[k]; });
    return { ...doc, version: 2, project: { ...doc.project, ...added } };
  }
};

// Any version's decoded project.json -> the current version (not yet checked)
export function migrate(raw: unknown, defaults: Record<string, unknown>): ProjectDoc {
  if (!isObject(raw) || raw.format !== FORMAT) return fail('Not a NoProd project file');
  let doc: any = raw;
  if (!Number.isInteger(doc.version) || doc.version < 1) fail('The project file has no valid version');
  if (doc.version > SCHEMA_VERSION) fail(`This project was saved by a newer NoProd (project v${doc.version}); update NoProd to open it`);
  while (doc.version < SCHEMA_VERSION) doc = MIGRATIONS[doc.version](doc, defaults);
  return doc;
}

// ---- checks: each returns null, or what is wrong and where

type Check = (v: unknown, path: string) => string | null;

const num: Check = (v, p) => (typeof v === 'number' && Number.isFinite(v) ? null : `${p}: expected a number`);
const range = (lo: number, hi: number, integer = false): Check => (v, p) =>
  num(v, p) ?? ((v as number) < lo || (v as number) > hi || (integer && !Number.isInteger(v)) ? `${p}: ${v} is out of range` : null);
const str: Check = (v, p) => (typeof v === 'string' ? null : `${p}: expected text`);
const bool: Check = (v, p) => (typeof v === 'boolean' ? null : `${p}: expected true or false`);
const any: Check = () => null;
const nullable = (c: Check): Check => (v, p) => (v === null ? null : c(v, p));
const either = (...cs: Check[]): Check => (v, p) => (cs.some((c) => !c(v, p)) ? null : cs[0](v, p));
const oneOf = (...vals: unknown[]): Check => (v, p) => (vals.includes(v) ? null : `${p}: unexpected value ${JSON.stringify(v)}`);

const list = (c: Check, min = 0, max = Infinity): Check => (v, p) => {
  if (!Array.isArray(v)) return `${p}: expected a list`;
  if (v.length < min) return `${p}: expected at least ${min}`;
  if (v.length > max) return `${p}: more than ${max} items`;
  for (let i = 0; i < v.length; i++) { const e = c(v[i], `${p}[${i}]`); if (e) return e; }
  return null;
};

const record = (c: Check): Check => (v, p) => {
  if (!isObject(v)) return `${p}: expected an object`;
  for (const k of Object.keys(v)) { const e = c(v[k], `${p}.${k}`); if (e) return e; }
  return null;
};

// Keys ending in ? may be absent (or undefined); other keys are allowed
// through unchecked, since tracks and clips carry many optional settings
const shape = (fields: Record<string, Check>): Check => (v, p) => {
  if (!isObject(v)) return `${p}: expected an object`;
  for (const [key, c] of Object.entries(fields)) {
    const optional = key.endsWith('?');
    const k = optional ? key.slice(0, -1) : key;
    if (v[k] === undefined) { if (optional) continue; return `${p}.${k}: missing`; }
    const e = c(v[k], `${p}.${k}`);
    if (e) return e;
  }
  return null;
};

const device: Check = (v, p) => shape({
  'id?': str, name: str, 'type?': str, 'kind?': str, 'parameters?': nullable(record(any)),
  'devices?': list(device, 0, COUNT_LIMITS.devices),'macros?': list(shape({ id: str, 'name?': str, 'value?': num, 'mappings?': list(any) }))
})(v, p);

function projectChecks(bufferIds: Set<string>): Record<string, Check> {
  const buffer: Check = (v, p) => {
    if (!isObject(v) || typeof v.$audioBuffer !== 'string') return `${p}: expected audio`;
    return bufferIds.has(v.$audioBuffer) ? null : `${p}: refers to audio the file does not hold`;
  };
  const note = shape({ 'id?': either(str, num), pitch: range(0, 127), start: num, duration: num, 'velocity?': num });
  const clip = shape({ 'id?': str, 'type?': str, 'file?': str, duration: num, 'startOffset?': num, 'audioBuffer?': nullable(buffer), 'notes?': list(note, 0, COUNT_LIMITS.notes) });
  const region: Check = (v, p) => shape({ id: str, trackId: str, startTime: num })(v, p) ?? clip(v, p);
  const strip = { id: str, name: str, volume: num, pan: num, plugins: list(device, 0, COUNT_LIMITS.devices), 'isMuted?': bool };
  const track = shape({
    ...strip, type: oneOf('audio', 'midi', 'group'), 'sends?': record(num), 'instrument?': nullable(device),
    'isSoloed?': bool, 'isArmed?': bool, 'frozenBuffer?': nullable(buffer),
    'takeLanes?': list(shape({ id: str, name: str, regions: list(region) }), 0, COUNT_LIMITS.takeLanes)
  });
  return {
    bpm: range(20, 999),
    timeSignatures: list(shape({ bar: range(0, 1e6, true), numerator: range(1, 99, true), denominator: range(1, 64, true) }), 1, COUNT_LIMITS.timeSignatures),
    countInBars: range(0, 64),
    masterVolume: num,
    masterPan: range(-1, 1),
    returns: list(shape(strip), 0, COUNT_LIMITS.returns),
    masterPlugins: list(device, 0, COUNT_LIMITS.devices),
    isLimiterEnabled: bool,
    isLoopEnabled: bool,
    loopStart: num,
    loopEnd: num,
    locators: list(shape({ id: str, time: num, 'name?': str }), 0, COUNT_LIMITS.locators),
    punchInTime: num,
    punchOutTime: num,
    isPunchEnabled: bool,
    vstScanPaths: list(str),
    tracks: list(track, 0, COUNT_LIMITS.tracks),
    regions: list(region, 0, COUNT_LIMITS.regions),
    sessionClips: record(record(clip)),
    scenes: list(shape({ id: str, 'name?': str, 'tempo?': nullable(num) })),
    launchQuantization: str,
    savedRacks: list(device),
    // Mappings to tracks or devices that are gone are dropped by loadProject
    midiMappings: list(shape({
      id: str,
      target: shape({ kind: oneOf('track', 'send', 'master', 'device', 'instrument', 'tempo') }),
      source: shape({ input: str, channel: range(1, 16, true), type: oneOf('cc', 'note'), number: range(0, 127, true) }),
      min: range(0, 1), max: range(0, 1), mode: oneOf('pickup', 'jump'), invert: bool
    }), 0, COUNT_LIMITS.midiMappings)
  };
}

// The keys of a project, as this version of the schema knows them
export const SCHEMA_KEYS = Object.keys(projectChecks(new Set()));

const bufferInfo = shape({
  id: str,
  sampleRate: range(BUFFER_LIMITS.minSampleRate, BUFFER_LIMITS.maxSampleRate, true),
  length: range(1, BUFFER_LIMITS.frames, true),
  channels: range(1, BUFFER_LIMITS.channels, true)
});

// A migrated doc -> null if it is a valid current project, else the problem
export function validateDoc(doc: ProjectDoc): string | null {
  try {
    if (doc.version !== SCHEMA_VERSION) return `version ${doc.version} is not ${SCHEMA_VERSION}`;
    const buffersProblem = list(bufferInfo)(doc.buffers, 'buffers');
    if (buffersProblem) return buffersProblem;
    if (doc.buffers.length > BUFFER_LIMITS.count) return 'buffers: more than NoProd accepts';
    const ids = new Set(doc.buffers.map((b) => b.id));
    if (ids.size !== doc.buffers.length) return 'buffers: two share an id';
    return shape(projectChecks(ids))(doc.project, 'project');
  } catch (err) {
    if (err instanceof RangeError) return 'project: nested too deeply';
    throw err;
  }
}

// Only the keys the schema knows go into the store
export const knownKeys = (project: Record<string, any>) => {
  const out: Record<string, any> = {};
  SCHEMA_KEYS.forEach((k) => { out[k] = project[k]; });
  return out;
};

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KITS, STRUDEL_DRUM_NAMES, STRUDEL_SYNTHS, findSound, strudelKit, strudelNoteToMidi, strudelParts, strudelSound
} from '../src/index.ts';

test('every synth name dictation knows plays a library sound', () => {
  for (const name of STRUDEL_SYNTHS) {
    const { sound } = strudelSound(name, true);
    assert.ok(sound && findSound(sound), `${name} → ${sound}`);
  }
  assert.equal(strudelSound('gm_epiano1', true).sound, 'piano-electric');
  assert.equal(strudelSound('gm_acoustic_grand_piano', true).sound, 'piano-grand');
  assert.equal(strudelSound('gm_string_ensemble_1', true).sound, 'strings-ensemble');
  // General MIDI's acoustic instruments play the modeled ones
  for (const [name, id] of [['gm_violin', 'violin'], ['gm_viola', 'viola'], ['gm_cello', 'cello'], ['gm_contrabass', 'double-bass'],
    ['gm_trombone', 'trombone'], ['gm_french_horn', 'french-horn'], ['gm_recorder', 'recorder'], ['gm_banjo', 'banjo'],
    ['gm_acoustic_guitar_steel', 'guitar-steel'], ['gm_steel_drums', 'steel-drum'], ['gm_acoustic_bass', 'bass-finger'],
    ['gm_pizzicato_strings', 'pizzicato'], ['gm_harpsichord', 'harpsichord'], ['gm_orchestral_harp', 'harp']]) {
    assert.equal(strudelSound(name, true).sound, id, name);
  }
  assert.equal(strudelSound(undefined, true).sound, 'lead-triangle', "Strudel's default synth");
  assert.equal(strudelSound('who-knows', true).sound, 'lead-triangle');
});

// Every General MIDI name Strudel's soundfont has (`node_modules/@strudel/soundfonts`)
const GM_NAMES = [
  'gm_accordion', 'gm_acoustic_bass', 'gm_acoustic_guitar_nylon', 'gm_acoustic_guitar_steel', 'gm_acoustic_piano',
  'gm_agogo', 'gm_alto_sax', 'gm_applause', 'gm_bagpipe', 'gm_bandoneon', 'gm_banjo', 'gm_baritone_sax',
  'gm_bassoon', 'gm_bird_tweet', 'gm_blown_bottle', 'gm_brass_section', 'gm_breath_noise',
  'gm_bright_acoustic_piano', 'gm_celesta', 'gm_cello', 'gm_choir_aahs', 'gm_church_organ', 'gm_clarinet',
  'gm_clavinet', 'gm_contrabass', 'gm_distortion_guitar', 'gm_drawbar_organ', 'gm_dulcimer',
  'gm_electric_bass_finger', 'gm_electric_bass_pick', 'gm_electric_grand_piano', 'gm_electric_guitar_clean',
  'gm_electric_guitar_jazz', 'gm_electric_guitar_muted', 'gm_english_horn', 'gm_epiano1', 'gm_epiano2', 'gm_fiddle',
  'gm_flute', 'gm_french_horn', 'gm_fretless_bass', 'gm_fx_atmosphere', 'gm_fx_brightness', 'gm_fx_crystal',
  'gm_fx_echoes', 'gm_fx_goblins', 'gm_fx_rain', 'gm_fx_sci_fi', 'gm_fx_soundtrack', 'gm_glockenspiel',
  'gm_guitar_fret_noise', 'gm_guitar_harmonics', 'gm_gunshot', 'gm_harmonica', 'gm_harpsichord', 'gm_helicopter',
  'gm_honky_tonk_piano', 'gm_kalimba', 'gm_koto', 'gm_lead_1_square', 'gm_lead_2_sawtooth', 'gm_lead_3_calliope',
  'gm_lead_4_chiff', 'gm_lead_5_charang', 'gm_lead_6_voice', 'gm_lead_7_fifths', 'gm_lead_8_bass_lead', 'gm_marimba',
  'gm_melodic_tom', 'gm_music_box', 'gm_muted_trumpet', 'gm_oboe', 'gm_ocarina', 'gm_orchestra_hit',
  'gm_orchestral_harp', 'gm_overdriven_guitar', 'gm_pad_bowed', 'gm_pad_choir', 'gm_pad_halo', 'gm_pad_metallic',
  'gm_pad_new_age', 'gm_pad_poly', 'gm_pad_sweep', 'gm_pad_warm', 'gm_pan_flute', 'gm_percussive_organ', 'gm_piano',
  'gm_piccolo', 'gm_pizzicato_strings', 'gm_recorder', 'gm_reed_organ', 'gm_reverse_cymbal', 'gm_rock_organ',
  'gm_seashore', 'gm_shakuhachi', 'gm_shamisen', 'gm_shanai', 'gm_sitar', 'gm_slap_bass_1', 'gm_slap_bass_2',
  'gm_soprano_sax', 'gm_steel_drums', 'gm_string_ensemble_1', 'gm_string_ensemble_2', 'gm_synth_bass_1',
  'gm_synth_bass_2', 'gm_synth_brass_1', 'gm_synth_brass_2', 'gm_synth_choir', 'gm_synth_drum', 'gm_synth_strings_1',
  'gm_synth_strings_2', 'gm_taiko_drum', 'gm_telephone', 'gm_tenor_sax', 'gm_timpani', 'gm_tinkle_bell',
  'gm_tremolo_strings', 'gm_trombone', 'gm_trumpet', 'gm_tuba', 'gm_tubular_bells', 'gm_vibraphone', 'gm_viola',
  'gm_violin', 'gm_voice_oohs', 'gm_whistle', 'gm_woodblock', 'gm_xylophone'
];

test('every General MIDI name plays a library sound, not the default synth', () => {
  for (const name of GM_NAMES) {
    const { sound } = strudelSound(name, true);
    assert.ok(sound && findSound(sound), `${name} → ${sound}`);
    assert.notEqual(sound, 'lead-triangle', name);
  }
});

test('every drum name dictation knows is a pad on every kit', () => {
  for (const name of STRUDEL_DRUM_NAMES) {
    const { drum } = strudelSound(name, false);
    assert.ok(drum !== undefined, name);
    for (const kit of KITS) assert.ok(kit.pads[drum!], `${kit.name} has nothing for ${name} (${drum})`);
  }
  assert.equal(strudelSound('bd:3', false).drum, 36, 'a sample index');
  assert.equal(strudelSound('808bd', false).drum, 36, 'a drum-like sample name');
  assert.deepEqual(strudelSound('vinylnoise', false), {}, 'nothing to play');
});

test('banks pick kits', () => {
  assert.equal(strudelKit('RolandTR808'), 'kit-808');
  assert.equal(strudelKit('RolandTR909'), 'kit-electronic');
  assert.equal(strudelKit('LinnDrum'), 'kit-acoustic');
  assert.equal(strudelKit(undefined), 'kit-808');
});

test('note names read as Strudel reads them', () => {
  const cases: [string | number, number][] = [['c3', 48], ['c4', 60], ['a4', 69], ['eb4', 63], ['cs2', 37], ['c#2', 37], ['a', 57], [60, 60], ['62', 62]];
  for (const [name, midi] of cases) assert.equal(strudelNoteToMidi(name), midi, String(name));
  assert.equal(strudelNoteToMidi('h7'), undefined);
});

test('a cycle of haps becomes a kit part and a part per sound', () => {
  const { parts, unmapped } = strudelParts([
    { time: 0, duration: 0.25, s: 'bd', bank: 'RolandTR909' },
    { time: 0.25, duration: 0.25, s: 'sd', bank: 'RolandTR909', gain: 0.5 },
    { time: 0, duration: 0.125, s: 'hh', bank: 'RolandTR909' },
    { time: 0, duration: 0.5, s: 'sawtooth', pitch: 'c3' },
    { time: 0.5, duration: 0.5, s: 'sawtooth', pitch: 'g3' },
    { time: 0, duration: 1, pitch: 'e4' },
    { time: 0, duration: 0.1, s: 'vinylnoise' },
    // an older Sequencer: `note` is the note, or else the sound
    { time: 0.5, duration: 0.25, note: 'cp' },
    { time: 0.75, duration: 0.25, note: 'a2' }
  ]);
  const kit = parts.find((p) => p.kind === 'kit' && p.id === 'kit-electronic')!;
  assert.deepEqual(kit.notes.map((n) => n.pitch), [36, 38, 42]);
  assert.equal(kit.notes[1].velocity, 0.4);
  assert.deepEqual(parts.find((p) => p.id === 'lead-saw')!.notes.map((n) => [n.pitch, n.start, n.duration]), [[48, 0, 0.5], [55, 0.5, 0.5]]);
  assert.deepEqual(parts.find((p) => p.id === 'lead-triangle')!.notes.map((n) => n.pitch), [64, 45]);
  assert.deepEqual(parts.find((p) => p.kind === 'kit' && p.id === 'kit-808')!.notes.map((n) => n.pitch), [39]);
  assert.deepEqual(unmapped, ['vinylnoise']);
});

// The orchestrator's dictation prompt lists the names it may use; they must
// be the ones the library plays
test('the dictation prompt names exactly the sounds the library plays', () => {
  const source = readFileSync(new URL('../../../apps/orchestrator/index.js', import.meta.url), 'utf8');
  const list = (name: string) => JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(source)![1].replace(/'/g, '"'));
  assert.deepEqual(list('DRUM_NAMES'), STRUDEL_DRUM_NAMES);
  assert.deepEqual(list('SYNTH_NAMES'), STRUDEL_SYNTHS);
});

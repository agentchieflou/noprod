import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateCycle, parseProgram, tokenizeProgram, PatternError, noteToMidi, parseScale, scaleDegree, soundControls } from '../src/index.ts';

// One cycle as "time duration {value}" lines, written out by hand below
const cycle = (code: string) => evaluateCycle(code).events.map((e) => `${e.time} ${e.duration} ${JSON.stringify(e.value)}`);
const values = (code: string) => evaluateCycle(code).events.map((e) => e.value);
const fails = (code: string, message: RegExp) => assert.throws(() => evaluateCycle(code), (e: unknown) => e instanceof PatternError && message.test(e.message), code);

test('tokens and the tree', () => {
  assert.deepEqual(tokenizeProgram('setcpm(120/4)\ns("bd").fast(2) // beat').map((t) => t.text),
    ['setcpm', '(', '120', '/', '4', ')', '\n', 's', '(', '"bd"', ')', '.', 'fast', '(', '2', ')', '']);
  assert.deepEqual(tokenizeProgram('x => x.rev()').map((t) => t.text), ['x', '=>', 'x', '.', 'rev', '(', ')', '']);
  assert.deepEqual(tokenizeProgram("'a' `b` \"c\\n\"").map((t) => t.value), ['a', 'b', 'c\n', undefined]);
  const program = parseProgram('$: s("bd")\n_$: s("sd")\nnote("c3").s("piano")');
  assert.deepEqual(program.statements.map((s) => [s.label, s.muted, s.expr.type]), [['$', false, 'call'], ['$', true, 'call'], [undefined, undefined, 'call']]);
  const call = parseProgram('a.b(1, "x", [2], y => y)').statements[0].expr;
  assert.equal(call.type, 'call');
  if (call.type === 'call') {
    assert.deepEqual(call.callee, { type: 'member', object: { type: 'identifier', name: 'a', pos: 0 }, name: 'b', pos: 1 });
    assert.deepEqual(call.args.map((a) => a.type), ['number', 'string', 'array', 'arrow']);
  }
  assert.throws(() => parseProgram('s("bd"'), /expected "," or "\)" but found the end of the program at 1:7/);
  assert.throws(() => parseProgram('s("bd'), /a string that never ends at 1:3/);
  assert.throws(() => parseProgram('s("bd") s("sd")'), /unexpected "s"; expected the end of the line/);
  assert.throws(() => parseProgram('const x = 1'), /unexpected character "="/);
  assert.throws(() => parseProgram('d1: s("bd")'), /unknown label "d1:"/);
  assert.throws(() => parseProgram('() => 1'), /one parameter/);
  assert.throws(() => parseProgram('`${x}`'), /can't interpolate/);
  assert.throws(() => parseProgram('/* open'), /never ends/);
  assert.deepEqual(parseProgram('').statements, []);
});

test('controls as functions', () => {
  assert.deepEqual(cycle('note("c3 e3")'), ['0 0.5 {"note":"c3"}', '0.5 0.5 {"note":"e3"}']);
  assert.deepEqual(cycle('s("bd sd")'), ['0 0.5 {"s":"bd"}', '0.5 0.5 {"s":"sd"}']);
  assert.deepEqual(cycle('sound("bd")'), ['0 1 {"s":"bd"}']);
  assert.deepEqual(cycle('n("0 2")'), ['0 0.5 {"n":0}', '0.5 0.5 {"n":2}']);
  assert.deepEqual(cycle('s("bd:3 sd:1")'), ['0 0.5 {"s":"bd","n":3}', '0.5 0.5 {"s":"sd","n":1}']);
  assert.deepEqual(cycle('note(60)'), ['0 1 {"note":60}']);
  assert.deepEqual(cycle('note(["c3", "e3"])'), ['0 0.5 {"note":"c3"}', '0.5 0.5 {"note":"e3"}'], 'an array is a sequence');
  assert.deepEqual(cycle('note("c3", "e3")'), ['0 0.5 {"note":"c3"}', '0.5 0.5 {"note":"e3"}'], 'so are several arguments');
  assert.deepEqual(cycle('gain("1 0.5")'), ['0 0.5 {"gain":1}', '0.5 0.5 {"gain":0.5}']);
  fails('s("a:1:2")', /"name" or "name:index"/);
  fails('s("a:x")', /whole number/);
  fails('note(note("c3"))', /wants plain values/);
});

test('controls as methods keep the structure of the pattern', () => {
  assert.deepEqual(cycle('note("c3 e3").s("piano")'), ['0 0.5 {"note":"c3","s":"piano"}', '0.5 0.5 {"note":"e3","s":"piano"}']);
  assert.deepEqual(cycle('note("c e").s("<piano sawtooth>")'), ['0 0.5 {"note":"c","s":"piano"}', '0.5 0.5 {"note":"e","s":"piano"}']);
  assert.deepEqual(evaluate('note("c e").s("<piano sawtooth>")').pattern.onsetsOnly().queryArc(1, 2).map((h) => h.value.s), ['sawtooth', 'sawtooth']);
  assert.deepEqual(cycle('s("bd sd").gain("1 0.5")'), ['0 0.5 {"s":"bd","gain":1}', '0.5 0.5 {"s":"sd","gain":0.5}']);
  assert.deepEqual(cycle('s("bd").gain("1 0.5")'), ['0 1 {"s":"bd","gain":1}'], 'the first value under a long event');
  assert.deepEqual(cycle('s("bd").velocity(0.5).pan(0.2).bank("RolandTR909").orbit(2)'), ['0 1 {"s":"bd","velocity":0.5,"pan":0.2,"bank":"RolandTR909","orbit":2}']);
  assert.deepEqual(cycle('note("c").gain(0.5).gain(0.8)'), ['0 1 {"note":"c","gain":0.8}'], 'the last setting wins');
  assert.deepEqual(cycle('note("c").s("piano").s("bass")'), ['0 1 {"note":"c","s":"bass"}']);
  assert.deepEqual(cycle('s("bd:1").n(3)'), ['0 1 {"s":"bd","n":3}']);
  assert.deepEqual(cycle('s("bd").velo(0.5).amp(0.3)'), ['0 1 {"s":"bd","velocity":0.5,"gain":0.3}'], 'aliases');
  assert.deepEqual(cycle('s("bd").room(0.3).lpf(800).attack(0.01)'), ['0 1 {"s":"bd","room":0.3,"lpf":800,"attack":0.01}'], 'other controls ride along');
  assert.deepEqual(cycle('s("bd").pianoroll().color("red")'), ['0 1 {"s":"bd"}'], 'visual methods do nothing');
  fails('"bd sd".s("x")', /wants a pattern with controls/);
  fails('s("bd").foo()', /unknown method "\.foo" at 1:8/);
  fails('s("bd").rev', /needs parentheses: \.rev\(\)/);
});

test('bare values play as notes or sounds', () => {
  assert.deepEqual(cycle('"c3 e3"'), ['0 0.5 {"note":"c3"}', '0.5 0.5 {"note":"e3"}']);
  assert.deepEqual(cycle('"bd sd"'), ['0 0.5 {"s":"bd"}', '0.5 0.5 {"s":"sd"}']);
  assert.deepEqual(cycle('"60 64"'), ['0 0.5 {"note":60}', '0.5 0.5 {"note":64}']);
  assert.deepEqual(cycle('"c3 e3".add(12)'), ['0 0.5 {"note":60}', '0.5 0.5 {"note":64}'], 'strings have the methods');
  assert.deepEqual(cycle('"<bd sd>*2".fast(2)'), ['0 0.25 {"s":"bd"}', '0.25 0.25 {"s":"sd"}', '0.5 0.25 {"s":"bd"}', '0.75 0.25 {"s":"sd"}']);
});

test('stack, cat, seq and friends', () => {
  assert.deepEqual(cycle('stack(s("bd"), note("c3 e3"))'), ['0 1 {"s":"bd"}', '0 0.5 {"note":"c3"}', '0.5 0.5 {"note":"e3"}']);
  assert.deepEqual(cycle('stack(s("bd"), s("sd")).fast(2)').length, 4);
  assert.deepEqual(cycle('cat(s("a"), s("b c"))'), ['0 1 {"s":"a"}']);
  assert.deepEqual(evaluate('cat(s("a"), s("b c"))').pattern.onsetsOnly().queryArc(1, 2).map((h) => h.value.s), ['b', 'c']);
  assert.deepEqual(cycle('seq(s("a"), s("b c"))'), ['0 0.5 {"s":"a"}', '0.5 0.25 {"s":"b"}', '0.75 0.25 {"s":"c"}']);
  assert.deepEqual(cycle('sequence(s("a"), s("b"))'), cycle('fastcat(s("a"), s("b"))'));
  assert.deepEqual(cycle('slowcat(s("a"), s("b"))'), ['0 1 {"s":"a"}']);
  assert.deepEqual(cycle('timecat([3, s("a")], [1, s("b")])'), ['0 0.75 {"s":"a"}', '0.75 0.25 {"s":"b"}']);
  assert.deepEqual(cycle('stack()'), []);
  assert.deepEqual(cycle('silence'), []);
  assert.deepEqual(cycle('hush()'), []);
  assert.deepEqual(cycle('stack(s("bd"), silence)'), ['0 1 {"s":"bd"}']);
  fails('timecat(s("a"))', /\[weight, pattern\] pairs/);
});

test('time: fast, slow, early, late, rev, ply, iter, palindrome', () => {
  assert.deepEqual(cycle('s("a b").fast(2)'), ['0 0.25 {"s":"a"}', '0.25 0.25 {"s":"b"}', '0.5 0.25 {"s":"a"}', '0.75 0.25 {"s":"b"}']);
  assert.deepEqual(cycle('s("a b").slow(2)'), ['0 1 {"s":"a"}']);
  assert.deepEqual(cycle('s("a b").fast("1 2")'), ['0 0.5 {"s":"a"}', '0.5 0.25 {"s":"a"}', '0.75 0.25 {"s":"b"}'], 'a patterned factor');
  assert.deepEqual(cycle('s("a b").hurry(2)').length, 4);
  assert.deepEqual(cycle('s("a b").late(0.25)'), ['0.25 0.5 {"s":"a"}', '0.75 0.5 {"s":"b"}']);
  assert.deepEqual(cycle('s("a b").early(0.25)'), ['0.25 0.5 {"s":"b"}', '0.75 0.5 {"s":"a"}']);
  assert.deepEqual(cycle('s("a b").late(1/4)'), cycle('s("a b").late(0.25)'), 'arithmetic in arguments');
  assert.deepEqual(cycle('s("a b c").rev()'), ['0 0.3333333333333333 {"s":"c"}', '0.3333333333333333 0.3333333333333333 {"s":"b"}', '0.6666666666666666 0.3333333333333333 {"s":"a"}']);
  assert.deepEqual(cycle('s("a b").ply(2)'), ['0 0.25 {"s":"a"}', '0.25 0.25 {"s":"a"}', '0.5 0.25 {"s":"b"}', '0.75 0.25 {"s":"b"}']);
  assert.deepEqual(evaluate('s("a b c d").iter(4)').pattern.onsetsOnly().queryArc(1, 2).map((h) => h.value.s), ['b', 'c', 'd', 'a']);
  assert.deepEqual(evaluate('s("a b c d").iterBack(4)').pattern.onsetsOnly().queryArc(1, 2).map((h) => h.value.s), ['d', 'a', 'b', 'c']);
  assert.deepEqual(evaluate('s("a b").palindrome()').pattern.onsetsOnly().queryArc(1, 2).map((h) => h.value.s), ['b', 'a']);
  fails('s("a").fast("x")', /fast wants a number, not "x"/);
  fails('s("a").fast()', /\.fast wants 1 argument, not 0/);
  fails('s("a").iter("4")', /iter wants a number/);
});

test('structure: every, struct, mask, euclid, off, superimpose, layer', () => {
  const second = (code: string) => evaluate(code).pattern.onsetsOnly().queryArc(1, 2).map((h) => `${h.whole!.begin} ${h.value.s}`);
  assert.deepEqual(cycle('s("a b").every(2, fast(2))').length, 4);
  assert.deepEqual(second('s("a b").every(2, fast(2))'), ['1 a', '3/2 b']);
  assert.deepEqual(cycle('s("a b").every(3, rev)').map((e) => JSON.parse(e.split(' ')[2]).s), ['b', 'a']);
  assert.deepEqual(cycle('s("a b").every(4, x => x.fast(2))').length, 4);
  assert.deepEqual(cycle('s("a b").firstOf(2, x => x.rev())').map((e) => JSON.parse(e.split(' ')[2]).s), ['b', 'a']);
  assert.deepEqual(cycle('s("a b").lastOf(2, x => x.rev())').map((e) => JSON.parse(e.split(' ')[2]).s), ['a', 'b']);
  assert.deepEqual(second('s("a b").lastOf(2, x => x.rev())'), ['1 b', '3/2 a']);
  assert.deepEqual(cycle('s("a b").every("<2 3>", fast(2))').length, 4);
  assert.deepEqual(cycle('note("c3").struct("t ~ t t")'), ['0 0.25 {"note":"c3"}', '0.5 0.25 {"note":"c3"}', '0.75 0.25 {"note":"c3"}']);
  assert.deepEqual(cycle('s("a b").mask("1 0")'), ['0 0.5 {"s":"a"}']);
  assert.deepEqual(cycle('s("a").euclid(3, 8)'), ['0 0.125 {"s":"a"}', '0.375 0.125 {"s":"a"}', '0.75 0.125 {"s":"a"}']);
  assert.deepEqual(cycle('s("a").euclid(3, 8, 2)'), ['0 0.125 {"s":"a"}', '0.25 0.125 {"s":"a"}', '0.625 0.125 {"s":"a"}']);
  assert.deepEqual(cycle('s("a").euclidRot(3, 8, 2)'), cycle('s("a").euclid(3, 8, 2)'));
  assert.deepEqual(cycle('s("a b").off(0.125, x => x.s("c"))'), ['0 0.5 {"s":"a"}', '0.125 0.5 {"s":"c"}', '0.5 0.5 {"s":"b"}', '0.625 0.5 {"s":"c"}']);
  assert.deepEqual(cycle('note("c3 e3").off(1/8, x => x.add(12))'), ['0 0.5 {"note":"c3"}', '0.125 0.5 {"note":60}', '0.5 0.5 {"note":"e3"}', '0.625 0.5 {"note":64}']);
  assert.deepEqual(cycle('s("a b").superimpose(fast(2))').length, 6);
  assert.deepEqual(cycle('s("a b").layer(rev, x => x.fast(2))').length, 6);
  fails('s("a").every(2)', /\.every wants 2 arguments, not 1/);
  fails('s("a").every(2, 3)', /every wants a function/);
  fails('s("a").every(2, x => rev)', /every's function wants a pattern, not the function rev/);
  fails('s("a").euclid(3)', /\.euclid wants 2 arguments/);
});

test('randomness is deterministic', () => {
  const a = cycle('s("hh*16").degradeBy(0.5)');
  assert.ok(a.length > 3 && a.length < 13, `${a.length} of 16`);
  assert.deepEqual(cycle('s("hh*16").degradeBy(0.5)'), a);
  assert.deepEqual(cycle('s("hh*16?")'), a, 'the first ? in a string and degradeBy share a stream');
  assert.deepEqual(cycle('s("hh*8").degrade()').length + cycle('s("hh*8").sometimesBy(0.5, x => x.gain(0))').filter((e) => e.includes('"gain":0')).length, 8);
  const some = values('s("hh*8").sometimes(x => x.gain(0.2))');
  assert.equal(some.length, 8);
  assert.ok(some.some((v) => v.gain === 0.2) && some.some((v) => v.gain === undefined));
  assert.ok(values('s("hh*16").often(x => x.gain(0.2))').filter((v) => v.gain).length > values('s("hh*16").rarely(x => x.gain(0.2))').filter((v) => v.gain).length);
  assert.deepEqual(values('s("hh*4").almostNever(x => x.gain(0.2))').filter((v) => v.gain).length <= 2, true);
  assert.deepEqual(values('s("hh*4").almostAlways(x => x.gain(0.2))').filter((v) => v.gain).length >= 2, true);
  assert.deepEqual(values('s("hh*4").always(x => x.gain(0.2))').every((v) => v.gain === 0.2), true);
  assert.deepEqual(values('s("hh*4").never(x => x.gain(0.2))').every((v) => v.gain === undefined), true);
  const cycles = Array.from({ length: 8 }, (_, c) => evaluate('s("a b").someCycles(x => x.s("X"))').pattern.onsetsOnly().queryArc(c, c + 1).map((h) => h.value.s));
  assert.ok(cycles.every((c) => c.join() === 'X,X' || c.join() === 'a,b'));
  assert.ok(cycles.some((c) => c[0] === 'X') && cycles.some((c) => c[0] === 'a'));
  const gains = values('s("hh*4").gain(rand)').map((v) => v.gain as number);
  assert.ok(gains.every((g) => g >= 0 && g < 1));
  assert.deepEqual(values('s("hh*4").gain(rand)').map((v) => v.gain), gains);
  assert.ok(values('s("hh*4").gain(rand.range(0.4, 0.8))').every((v) => (v.gain as number) >= 0.4 && (v.gain as number) <= 0.8));
  assert.ok(values('n(irand(8)).struct("t*8")').every((v) => Number.isInteger(v.n) && (v.n as number) >= 0 && (v.n as number) < 8));
});

test('signals as control values', () => {
  assert.deepEqual(values('s("a b").pan(sine)').map((v) => v.pan), [1, 2.220446049250313e-16].map((x) => Math.round(x * 1e6) / 1e6).map((x) => x) .map((x, i) => [1, 0][i] ?? x), 'sampled at the middle of each event');
  assert.deepEqual(values('s("a b").pan(saw)').map((v) => v.pan), [0.25, 0.75]);
  assert.deepEqual(values('s("a b").pan(isaw)').map((v) => v.pan), [0.75, 0.25]);
  assert.deepEqual(values('s("a b").pan(square)').map((v) => v.pan), [0, 1]);
  assert.deepEqual(values('s("a b").pan(tri)').map((v) => v.pan), [0.5, 0.5]);
  assert.deepEqual(values('s("a b").pan(cosine)').map((v) => Math.round((v.pan as number) * 1000) / 1000), [0.5, 0.5]);
});

test('pitch: add, sub, transpose, scale', () => {
  assert.deepEqual(values('note("c e g").add(12)').map((v) => v.note), [60, 64, 67]);
  assert.deepEqual(values('note("c3 e3").transpose("<0 12>")').map((v) => v.note), [48, 52]);
  assert.deepEqual(evaluate('note("c3 e3").transpose("<0 12>")').pattern.onsetsOnly().queryArc(1, 2).map((h) => h.value.note), [60, 64]);
  assert.deepEqual(values('note("60 64").transpose(1)').map((v) => v.note), [61, 65]);
  assert.deepEqual(values('note("c a f e").sub(12)').map((v) => v.note), [36, 45, 41, 40]);
  assert.deepEqual(values('note("c").add(note(12))').map((v) => v.note), [60], 'adding a control pattern adds key by key');
  assert.deepEqual(values('note("c").s("piano").add(note(12))'), [{ note: 60, s: 'piano' }]);
  assert.deepEqual(values('n("0 1").add(2)').map((v) => v.n), [2, 3], 'add goes to n when there is no note');
  assert.deepEqual(values('note("c3").n(1).add(2)'), [{ note: 50, n: 1 }], 'and to the note when there is one');
  assert.deepEqual(values('note("c e g".add("<0 3>"))').map((v) => v.note), [48, 52, 55]);
  assert.deepEqual(values('n("0 2 4 7").scale("C:major")').map((v) => v.note), [48, 52, 55, 60]);
  assert.deepEqual(values('n("0 1 2 3").scale("A2:minor")').map((v) => v.note), [45, 47, 48, 50]);
  assert.deepEqual(values('n("-1 0 7 8").scale("C4:major")').map((v) => v.note), [59, 60, 72, 74], 'degrees wrap');
  assert.deepEqual(values('n("0 2").scale("D:dorian")').map((v) => v.note), [50, 53]);
  assert.deepEqual(values('n("0 1 2 3 4").scale("C:minor:pentatonic")').map((v) => v.note), [48, 51, 53, 55, 58]);
  assert.deepEqual(values('n("0 2 4").scale("C:major").transpose(2)').map((v) => v.note), [50, 54, 57]);
  assert.deepEqual(values('n("0 2 4").scale("<C:major D:minor>")').map((v) => v.note), [48, 52, 55]);
  assert.deepEqual(evaluate('n("0 2 4").scale("<C:major D:minor>")').pattern.onsetsOnly().queryArc(1, 2).map((h) => h.value.note), [50, 53, 57]);
  assert.deepEqual(values('n("0 2 4").scale("Eb:major").s("piano")'), [{ note: 51, s: 'piano' }, { note: 55, s: 'piano' }, { note: 58, s: 'piano' }], 'n becomes the note');
  assert.deepEqual(values('n("0 2 4").scale("F#4:minor")').map((v) => v.note), [66, 69, 73]);
  assert.deepEqual(values('n("0 2 4").scale("c:major")').map((v) => v.note), [48, 52, 55]);
  assert.deepEqual(values('n("0 2 4").scale("C:ritusen")').map((v) => v.note), [48, 53, 57]);
  assert.deepEqual(values('n("0 2 4").scale("C:whole:tone")').map((v) => v.note), [48, 52, 56]);
  assert.deepEqual(values('n("0 2 4").scale("C:harmonic:minor")').map((v) => v.note), [48, 51, 55]);
  assert.deepEqual(values('n("0 2 4").scale("C:harmonic_minor")').map((v) => v.note), [48, 51, 55]);
  assert.deepEqual(values('n("0 2 4").scale("C:minor_pentatonic")').map((v) => v.note), [48, 53, 58]);
  fails('n("0").scale("C major")', /root and a name/);
  assert.deepEqual(values('"0 2 4".scale("C:major")').map((v) => v.note), [48, 52, 55], 'on plain numbers too');
  assert.deepEqual(values('n("0 2").add(1).scale("C:major")').map((v) => v.note), [50, 53]);
  fails('n("0").scale("C:nope")', /unknown scale "nope"/);
  fails('n("0").scale("major")', /root and a name/);
  fails('n("x").scale("C:major")', /whole-number degrees/);
  fails('note("c3").add("x")', /wants a number, not "x"/);
  fails('s("bd").add(1)', /add wants a pattern with a note or n/);
});

test('note names and sounds', () => {
  for (const [name, midi] of [['c3', 48], ['c4', 60], ['a4', 69], ['eb4', 63], ['cs2', 37], ['c#2', 37], ['a', 57], ['C', 48], ['Bb2', 46], [60, 60], ['62', 62], ['f##3', 55], ['-1', -1]] as [string | number, number][]) {
    assert.equal(noteToMidi(name), midi, String(name));
  }
  assert.throws(() => noteToMidi('h7'), PatternError);
  assert.throws(() => noteToMidi(undefined), PatternError);
  assert.deepEqual(parseScale('C:major'), { root: 48, steps: [0, 2, 4, 5, 7, 9, 11], name: 'major' });
  assert.equal(scaleDegree(parseScale('A2:minor'), 7), 57);
  assert.deepEqual(soundControls('bd:3'), { s: 'bd', n: 3 });
  assert.deepEqual(soundControls(808), { s: '808' });
});

test('tempo', () => {
  assert.deepEqual([evaluate('s("a")').cps, evaluate('s("a")').setsTempo], [0.5, false]);
  assert.deepEqual([evaluate('setcpm(120/4)\ns("a")').cps, evaluate('setcpm(120/4)\ns("a")').setsTempo], [0.5, true]);
  assert.equal(evaluate('setcpm(90/4); s("a")').cps, 0.375);
  assert.equal(evaluate('setcps(1); s("a")').cps, 1);
  assert.equal(evaluate('setbpm(100); s("a")').cps, 100 / 240);
  assert.deepEqual(cycle('s("a").cpm(60)'), ['0 0.5 {"s":"a"}', '0.5 0.5 {"s":"a"}'], '.cpm is relative to the program tempo');
  assert.deepEqual(cycle('setcpm(60); s("a").cpm(60)'), ['0 1 {"s":"a"}']);
  assert.deepEqual(cycle('s("a").cps(0.75)'), ['0 1 {"s":"a","cps":0.75}'], '.cps is a control, as in the published language');
  fails('setcpm(0); s("a")', /positive number/);
  fails('setcpm(-5); s("a")', /positive number/);
  fails('setcps(1000); s("a")', /too fast/);
  fails('setcpm("fast"); s("a")', /setcpm wants a number/);
  fails('setcpm(120)', /ends with a statement that makes no pattern/);
  fails('setcpm(120).fast(2)', /on nothing/);
});

test('programs: statements, labels, comments, chains across lines', () => {
  assert.deepEqual(cycle('$: s("bd*2")\n$: note("c3")'), ['0 0.5 {"s":"bd"}', '0 1 {"note":"c3"}', '0.5 0.5 {"s":"bd"}']);
  assert.deepEqual(cycle('_$: s("bd*2")\n$: note("c3")'), ['0 1 {"note":"c3"}'], '_$: mutes');
  assert.deepEqual(cycle('$: s("bd")\nsetcpm(100)'), ['0 1 {"s":"bd"}'], 'labels win over the last expression');
  assert.deepEqual(cycle('s("bd sd").fast(2); s("hh*4")').length, 4, 'the last expression plays');
  assert.deepEqual(cycle('// a beat\nsetcpm(120/4) // tempo\n/* drums */ s("bd")'), ['0 1 {"s":"bd"}']);
  assert.deepEqual(cycle('note("c3").s("piano")\n  .gain(0.5)\n  .slow(2)'), ['0 2 {"note":"c3","s":"piano","gain":0.5}']);
  assert.deepEqual(cycle('stack(\n  s("bd"),\n  s("sd")\n)'), ['0 1 {"s":"bd"}', '0 1 {"s":"sd"}']);
  assert.deepEqual(cycle('stack(s("bd"),\n s("sd"),)'), ['0 1 {"s":"bd"}', '0 1 {"s":"sd"}'], 'a trailing comma');
  assert.deepEqual(cycle('s("bd").fast(\n2\n)'), ['0 0.5 {"s":"bd"}', '0.5 0.5 {"s":"bd"}']);
  assert.deepEqual(cycle("s('bd')"), ['0 1 {"s":"bd"}']);
  assert.deepEqual(cycle('s(`bd`)'), ['0 1 {"s":"bd"}']);
  assert.deepEqual(cycle('s("bd").fast(-(-2))'), ['0 0.5 {"s":"bd"}', '0.5 0.5 {"s":"bd"}']);
  assert.deepEqual(cycle('s("bd").fast(1 + 1 * 2 - 6 / 3)'), ['0 1 {"s":"bd"}'], 'precedence');
  assert.deepEqual(cycle('s("bd").fast((1 + 1) * 2)').length, 4);
  assert.equal(evaluate('s("bd")\n\n\ns("sd")\n').statements, 2);
  fails('', /an empty program/);
  fails('// nothing', /an empty program/);
  fails('foo("bd")', /unknown name "foo" at 1:1/);
  fails('s(bd)', /unknown name "bd" at 1:3/);
  fails('s("bd") + 1', /"\+" wants numbers/);
  fails('1 / 0', /gives Infinity/);
  fails('-s("bd")', /"-" wants a number/);
  fails('s', /the function s/);
  fails('fast(2)', /the function fast/);
  fails('fast(2, 3, s("a"))', /fast wants 1 argument/);
  fails('(x => x.fast(2))(s("a"), s("b"))', /takes one argument, not 2/);
  fails('s("bd")(2)', /a pattern is not a function/);
  fails('rev.fast(2)', /on a function/);
  assert.deepEqual(cycle('[1, 2]'), ['0 0.5 {"note":1}', '0.5 0.5 {"note":2}'], 'bare numbers are notes');
  fails('[s]', /which can't be played|wants a pattern/);
  fails('x => x', /the function x/);
});

test('functions are curried and take the pattern last', () => {
  assert.deepEqual(cycle('fast(2, s("bd"))'), ['0 0.5 {"s":"bd"}', '0.5 0.5 {"s":"bd"}']);
  assert.deepEqual(cycle('rev(s("a b"))').map((e) => JSON.parse(e.split(' ')[2]).s), ['b', 'a']);
  assert.deepEqual(cycle('every(2, rev, s("a b"))').map((e) => JSON.parse(e.split(' ')[2]).s), ['b', 'a']);
  assert.deepEqual(cycle('s("a b").every(2, every(1, rev))').map((e) => JSON.parse(e.split(' ')[2]).s), ['b', 'a'], 'curried transforms compose');
  assert.deepEqual(cycle('struct("t ~ t t", note("c3"))').length, 3);
  assert.deepEqual(cycle('add(12, note("c3"))'), ['0 1 {"note":60}']);
  assert.deepEqual(cycle('scale("C:major", n("0 2"))').map((e) => JSON.parse(e.split(' ')[2]).note), [48, 52]);
  assert.deepEqual(cycle('s("bd").superimpose(late(0.25))'), ['0 1 {"s":"bd"}', '0.25 1 {"s":"bd"}']);
});

test('limits for untrusted programs', () => {
  fails('s("bd")'.padEnd(20000, ' '), /longer than 10000 characters/);
  fails('('.repeat(70) + 's("bd")' + ')'.repeat(70), /nested more than 64 deep/);
  assert.deepEqual(cycle('('.repeat(60) + 's("bd")' + ')'.repeat(60)), ['0 1 {"s":"bd"}']);
  fails(`stack(${'s("bd"),'.repeat(300)}s("bd"))`, /more than 256 arguments/);
  fails('s("bd*1000000")', /too many events/);
  fails('s("bd*100").fast(1000)', /too many events/);
  assert.throws(() => evaluateCycle('s("bd*100").fast(100)', { maxEvents: 1000 }), /too many events/);
  assert.equal(evaluateCycle('s("bd*100").fast(100)', { maxEvents: 100000 }).events.length, 10000);
  fails('s("bd").fast(2 ** 3)', /unexpected "\*"/);
});

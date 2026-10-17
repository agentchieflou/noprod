import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mini, parseMini, tokenize, PatternError, pure, Pattern, MINI_LIMITS } from '../src/index.ts';
import { events } from './helpers.ts';

// Expected events are "begin duration value", written out by hand
const ev = (src: string, cycles = 1, from = 0) => events(mini(src), cycles, from);
const fails = (src: string, message: RegExp) => assert.throws(() => mini(src).queryArc(0, 1), (e: unknown) => e instanceof PatternError && message.test(e.message), src);

test('tokens', () => {
  assert.deepEqual(tokenize('bd*2 [sd:3 ~] <c#3 eb4>!2 0.5 -1 ..').map((t) => t.text),
    ['bd', '*', '2', '[', 'sd:3', '~', ']', '<', 'c#3', 'eb4', '>', '!', '2', '0.5', '-1', '..', '']);
  assert.throws(() => tokenize('a $ b'), /unexpected character "\$" at 1:3/);
});

test('a sequence shares the cycle equally', () => {
  assert.deepEqual(ev('a'), ['0 1 a']);
  assert.deepEqual(ev('a b'), ['0 1/2 a', '1/2 1/2 b']);
  assert.deepEqual(ev('a b c'), ['0 1/3 a', '1/3 1/3 b', '2/3 1/3 c']);
  assert.deepEqual(ev('a b c d'), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 c', '3/4 1/4 d']);
  assert.deepEqual(ev('  a   b  '), ['0 1/2 a', '1/2 1/2 b'], 'whitespace is free');
  assert.deepEqual(ev('a\nb'), ['0 1/2 a', '1/2 1/2 b']);
});

test('rests take their step and make no event', () => {
  assert.deepEqual(ev('~'), []);
  assert.deepEqual(ev('a ~ b'), ['0 1/3 a', '2/3 1/3 b']);
  assert.deepEqual(ev('~ a'), ['1/2 1/2 a']);
  assert.deepEqual(ev('a ~ ~ ~'), ['0 1/4 a']);
  assert.deepEqual(ev('[~ a]'), ['1/2 1/2 a']);
  assert.deepEqual(ev('a [~ b]'), ['0 1/2 a', '3/4 1/4 b']);
});

test('sub-sequences', () => {
  assert.deepEqual(ev('[a b] c'), ['0 1/4 a', '1/4 1/4 b', '1/2 1/2 c']);
  assert.deepEqual(ev('a [b c]'), ['0 1/2 a', '1/2 1/4 b', '3/4 1/4 c']);
  assert.deepEqual(ev('[a [b c]] d'), ['0 1/4 a', '1/4 1/8 b', '3/8 1/8 c', '1/2 1/2 d']);
  assert.deepEqual(ev('[a]'), ['0 1 a']);
  assert.deepEqual(ev('[[a]]'), ['0 1 a']);
  assert.deepEqual(ev('a [b c] [d e f]'), ['0 1/3 a', '1/3 1/6 b', '1/2 1/6 c', '2/3 1/9 d', '7/9 1/9 e', '8/9 1/9 f']);
});

test('alternation: one step per cycle, each counting its own cycles', () => {
  assert.deepEqual(ev('<a b>', 4), ['0 1 a', '1 1 b', '2 1 a', '3 1 b']);
  assert.deepEqual(ev('<a b c>', 4), ['0 1 a', '1 1 b', '2 1 c', '3 1 a']);
  assert.deepEqual(ev('<a <b c>>', 4), ['0 1 a', '1 1 b', '2 1 a', '3 1 c']);
  assert.deepEqual(ev('a <b c>', 2), ['0 1/2 a', '1/2 1/2 b', '1 1/2 a', '3/2 1/2 c']);
  assert.deepEqual(ev('<a b>!2 c', 2), ['0 1/3 a', '1/3 1/3 a', '2/3 1/3 c', '1 1/3 b', '4/3 1/3 b', '5/3 1/3 c'], 'the same step twice in a cycle');
  assert.deepEqual(ev('<a b c>*2', 2), ['0 1/2 a', '1/2 1/2 b', '1 1/2 c', '3/2 1/2 a']);
  assert.deepEqual(ev('<a b>*3', 1), ['0 1/3 a', '1/3 1/3 b', '2/3 1/3 a']);
  assert.deepEqual(ev('<[a b] c>', 2), ['0 1/2 a', '1/2 1/2 b', '1 1 c']);
  assert.deepEqual(ev('<a>', 2), ['0 1 a', '1 1 a']);
  assert.deepEqual(ev('<a@3 b>', 4), ['0 3 a', '3 1 b'], 'a weight in <> is cycles');
  assert.deepEqual(ev('<a b, c>', 2), ['0 1 a', '0 1 c', '1 1 b', '1 1 c'], 'layers alternate on their own');
  assert.deepEqual(ev('<a b>@3 c', 2), ['0 3/4 a', '3/4 1/4 c', '1 3/4 b', '7/4 1/4 c']);
});

test('speed: * and /', () => {
  assert.deepEqual(ev('a*2'), ['0 1/2 a', '1/2 1/2 a']);
  assert.deepEqual(ev('a*4 b'), ['0 1/8 a', '1/8 1/8 a', '1/4 1/8 a', '3/8 1/8 a', '1/2 1/2 b']);
  assert.deepEqual(ev('[a b]*2'), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 a', '3/4 1/4 b']);
  assert.deepEqual(ev('a*1.5', 2), ['0 2/3 a', '2/3 2/3 a', '4/3 2/3 a']);
  assert.deepEqual(ev('a/2', 2), ['0 2 a']);
  assert.deepEqual(ev('a b/2', 2), ['0 1/2 a', '1/2 1 b', '1 1/2 a'], 'b every other cycle');
  assert.deepEqual(ev('a [b c]/2', 2), ['0 1/2 a', '1/2 1/2 b', '1 1/2 a', '3/2 1/2 c']);
  assert.deepEqual(ev('[a b c]/2', 2), ['0 2/3 a', '2/3 2/3 b', '4/3 2/3 c']);
  assert.deepEqual(ev('a*0'), [], 'no speed, no events');
  assert.deepEqual(ev('a/0'), []);
  assert.deepEqual(ev('a*-1'), []);
  assert.deepEqual(ev('a*2/2'), ['0 1 a']);
});

test('patterned speed', () => {
  assert.deepEqual(ev('bd*<2 3>', 2), ['0 1/2 bd', '1/2 1/2 bd', '1 1/3 bd', '4/3 1/3 bd', '5/3 1/3 bd']);
  assert.deepEqual(ev('a*[2 3]'), ['0 1/2 a', '2/3 1/3 a']);
  assert.deepEqual(ev('a/[1 2]', 2), ['0 1 a', '1 1 a']);
  assert.deepEqual(ev('a*<2 3>@2 b', 2), ['0 1/3 a', '1/3 1/3 a', '2/3 1/3 b', '1 2/9 a', '11/9 2/9 a', '13/9 2/9 a', '5/3 1/3 b']);
  fails('a*x', /expected a number after "\*"/);
  fails('a*<x y>', /wants a number, not "x"/);
});

test('replication: ! repeats a step', () => {
  assert.deepEqual(ev('a!3 b'), ['0 1/4 a', '1/4 1/4 a', '1/2 1/4 a', '3/4 1/4 b']);
  assert.deepEqual(ev('a ! b'), ['0 1/3 a', '1/3 1/3 a', '2/3 1/3 b']);
  assert.deepEqual(ev('a ! ! b'), ['0 1/4 a', '1/4 1/4 a', '1/2 1/4 a', '3/4 1/4 b']);
  assert.deepEqual(ev('[a b]!2 c'), ['0 1/6 a', '1/6 1/6 b', '1/3 1/6 a', '1/2 1/6 b', '2/3 1/3 c']);
  assert.deepEqual(ev('a [b c]!2'), ['0 1/3 a', '1/3 1/6 b', '1/2 1/6 c', '2/3 1/6 b', '5/6 1/6 c']);
  assert.deepEqual(ev('a!1 b'), ['0 1/2 a', '1/2 1/2 b']);
  assert.deepEqual(ev('a!0 b'), ['1/2 1/2 b'], 'repeated no times, a step of silence');
  assert.deepEqual(ev('a*2!2 b'), ['0 1/6 a', '1/6 1/6 a', '1/3 1/6 a', '1/2 1/6 a', '2/3 1/3 b']);
  assert.deepEqual(ev('a!2*2 b'), ev('a*2!2 b'), 'modifiers commute');
  assert.deepEqual(ev('a!x'), ['0 1/3 a', '1/3 1/3 a', '2/3 1/3 x'], 'a bare ! before a word repeats, then the word follows');
  fails('!a', /has no step to repeat/);
});

test('elongation: @ and _', () => {
  assert.deepEqual(ev('a@3 b'), ['0 3/4 a', '3/4 1/4 b']);
  assert.deepEqual(ev('a@2 b@1 c'), ['0 1/2 a', '1/2 1/4 b', '3/4 1/4 c']);
  assert.deepEqual(ev('a _ _ b'), ['0 3/4 a', '3/4 1/4 b']);
  assert.deepEqual(ev('a _ b _'), ['0 1/2 a', '1/2 1/2 b']);
  assert.deepEqual(ev('[a b]@2 c'), ['0 1/3 a', '1/3 1/3 b', '2/3 1/3 c']);
  assert.deepEqual(ev('a@1.5 b'), ['0 3/5 a', '3/5 2/5 b']);
  assert.deepEqual(ev('a b@0.5'), ['0 2/3 a', '2/3 1/3 b']);
  assert.deepEqual(ev('a*2@3 b'), ['0 3/8 a', '3/8 3/8 a', '3/4 1/4 b']);
  assert.deepEqual(ev('a@3*2 b'), ev('a*2@3 b'));
  assert.deepEqual(ev('a@0 b'), ['0 1/2 a', '1/2 1/2 b'], 'a weight of nothing counts as one');
  fails('_ a', /has no step to lengthen/);
  fails('a@', /"@" wants a number/);
});

test('polyphony: layers with ,', () => {
  assert.deepEqual(ev('a, b'), ['0 1 a', '0 1 b']);
  assert.deepEqual(ev('a b , c'), ['0 1/2 a', '0 1 c', '1/2 1/2 b']);
  assert.deepEqual(ev('a , b c , d e f'), ['0 1 a', '0 1/2 b', '0 1/3 d', '1/3 1/3 e', '1/2 1/2 c', '2/3 1/3 f']);
  assert.deepEqual(ev('[a b , c]*2'), ['0 1/4 a', '0 1/2 c', '1/4 1/4 b', '1/2 1/4 a', '1/2 1/2 c', '3/4 1/4 b']);
  assert.deepEqual(ev('[c4,e4,g4] a4'), ['0 1/2 c4', '0 1/2 e4', '0 1/2 g4', '1/2 1/2 a4'], 'a chord');
  fails('a,', /empty sequence/);
  fails(',a', /empty sequence/);
});

test('Euclidean rhythms', () => {
  assert.deepEqual(ev('x(3,8)'), ['0 1/8 x', '3/8 1/8 x', '3/4 1/8 x']);
  assert.deepEqual(ev('x(5,8)'), ['0 1/8 x', '1/4 1/8 x', '3/8 1/8 x', '5/8 1/8 x', '3/4 1/8 x']);
  assert.deepEqual(ev('x(3,4)'), ['0 1/4 x', '1/4 1/4 x', '1/2 1/4 x']);
  assert.deepEqual(ev('x(3,8,2)'), ['0 1/8 x', '1/4 1/8 x', '5/8 1/8 x'], 'turned two steps later');
  assert.deepEqual(ev('x(3,8,-1)'), ['1/4 1/8 x', '5/8 1/8 x', '7/8 1/8 x']);
  assert.deepEqual(ev('x(5,8,3)'), ['0 1/8 x', '1/8 1/8 x', '3/8 1/8 x', '5/8 1/8 x', '3/4 1/8 x']);
  assert.deepEqual(ev('x(-3,8)'), ['1/8 1/8 x', '1/4 1/8 x', '1/2 1/8 x', '5/8 1/8 x', '7/8 1/8 x'], 'negative hits invert');
  assert.deepEqual(ev('a b(3,8)'), ['0 1/2 a', '1/2 1/16 b', '11/16 1/16 b', '7/8 1/16 b']);
  assert.deepEqual(ev('x(<3 5>,8)', 2).length, 8);
  assert.deepEqual(ev('x([3 5],8)'), ['0 1/8 x', '3/8 1/8 x', '5/8 1/8 x', '3/4 1/8 x']);
  assert.deepEqual(ev('x(3,8,<0 2>)', 2), ['0 1/8 x', '3/8 1/8 x', '3/4 1/8 x', '1 1/8 x', '5/4 1/8 x', '13/8 1/8 x']);
  assert.deepEqual(ev('x(3,8)*2'), ['0 1/16 x', '3/16 1/16 x', '3/8 1/16 x', '1/2 1/16 x', '11/16 1/16 x', '7/8 1/16 x']);
  assert.deepEqual(ev('[a b](3,8)'), ['0 1/8 a', '3/8 1/8 a', '3/4 1/8 b']);
  fails('x(3)', /expected ","/);
  fails('x(3,8', /expected "\)"/);
  fails('x(3,8,1,2)', /expected "\)"/);
  fails('x(3,y)', /wants a number, not "y"/);
});

test('sample indices stay in the value', () => {
  assert.deepEqual(ev('bd:3 sd:1'), ['0 1/2 bd:3', '1/2 1/2 sd:1']);
  assert.deepEqual(ev('bd:3*2'), ['0 1/2 bd:3', '1/2 1/2 bd:3']);
  assert.deepEqual(ev('gm_epiano1:2'), ['0 1 gm_epiano1:2']);
  fails('a:', /unexpected character ":"/);
});

test('? drops events at random, the same way every time', () => {
  const hats = ev('hh*8?');
  assert.ok(hats.length >= 2 && hats.length <= 6, `${hats.length} of 8`);
  assert.deepEqual(ev('hh*8?'), hats);
  assert.deepEqual(ev('hh*8?'), ev('hh*8').filter((e) => hats.includes(e)), 'a subset of the plain pattern');
  assert.deepEqual(ev('hh*8?0'), ev('hh*8'));
  assert.deepEqual(ev('hh*8?1'), []);
  const few = ev('hh*16?0.9');
  const many = ev('hh*16?0.1');
  assert.ok(few.length < many.length, `${few.length} kept at 0.9, ${many.length} at 0.1`);
  // each ? is its own stream
  const twice = ev('a*8? b*8?');
  assert.notDeepEqual(twice.filter((e) => e.endsWith('a')).map((e) => e.split(' ')[0]), twice.filter((e) => e.endsWith('b')).map((e) => Number(e.split(' ')[0]) - 0.5));
  assert.deepEqual(ev('[a b]?', 4).length <= 8, true);
  fails('a?1.5', /probability from 0 to 1/);
});

test('| picks one alternative per cycle, the same way every time', () => {
  const picks = ev('a | b | c', 16).map((e) => e.split(' ')[2]);
  assert.equal(picks.length, 16);
  assert.ok(new Set(picks).size === 3, `all three turn up: ${picks}`);
  assert.deepEqual(ev('a | b | c', 16).map((e) => e.split(' ')[2]), picks);
  assert.deepEqual(ev('a*2 | b*3', 8).every((e) => (e.endsWith('a') ? e.includes(' 1/2 ') : e.includes(' 1/3 '))), true);
  const inner = ev('[a | b]*4');
  assert.equal(inner.length, 4);
  assert.deepEqual(ev('[a | b] c', 4).filter((e) => e.endsWith('c')).length, 4);
  assert.deepEqual(ev('a b | c', 4).every((e) => e.endsWith('c') ? e.includes(' 1 ') : e.includes(' 1/2 ')), true);
  // two | in one string are two streams
  const two = ev('[a | b] [c | d]', 32);
  const left = two.filter((e) => /a|b/.test(e)).map((e) => e.endsWith('a'));
  const right = two.filter((e) => /c|d/.test(e)).map((e) => e.endsWith('c'));
  assert.notDeepEqual(left, right);
  fails('a |', /empty sequence/);
});

test('. groups steps', () => {
  assert.deepEqual(ev('a . b c'), ['0 1/2 a', '1/2 1/4 b', '3/4 1/4 c']);
  assert.deepEqual(ev('a b . c'), ['0 1/4 a', '1/4 1/4 b', '1/2 1/2 c']);
  assert.deepEqual(ev('a b . c d e . f'), ['0 1/6 a', '1/6 1/6 b', '1/3 1/9 c', '4/9 1/9 d', '5/9 1/9 e', '2/3 1/3 f']);
  assert.deepEqual(ev('a*2 . b'), ['0 1/4 a', '1/4 1/4 a', '1/2 1/2 b']);
  assert.deepEqual(ev('a@2 . b'), ['0 1/2 a', '1/2 1/2 b'], 'weights are within the group');
  fails('a . . b', /empty sequence/);
});

test('.. is a range of whole numbers', () => {
  assert.deepEqual(ev('0 .. 3'), ['0 1/4 0', '1/4 1/4 1', '1/2 1/4 2', '3/4 1/4 3']);
  assert.deepEqual(ev('3 .. 0'), ['0 1/4 3', '1/4 1/4 2', '1/2 1/4 1', '3/4 1/4 0']);
  assert.deepEqual(ev('0 .. 2 5'), ['0 1/4 0', '1/4 1/4 1', '1/2 1/4 2', '3/4 1/4 5']);
  assert.deepEqual(ev('[0 .. 2]*2'), ['0 1/6 0', '1/6 1/6 1', '1/3 1/6 2', '1/2 1/6 0', '2/3 1/6 1', '5/6 1/6 2']);
  assert.deepEqual(ev('<0 .. 2>', 3), ['0 1 0', '1 1 1', '2 1 2']);
  assert.deepEqual(ev('-2 .. 1'), ['0 1/4 -2', '1/4 1/4 -1', '1/2 1/4 0', '3/4 1/4 1']);
  assert.deepEqual(ev('2 .. 2'), ['0 1 2']);
  fails('a .. c', /whole number on each side/);
  fails('0.5 .. 2', /whole number on each side/);
  fails('0 .. 5000', /more than 1024 steps/);
  fails('.. 2', /wants a whole number on each side/);
});

test('polymeter: {} and %', () => {
  assert.deepEqual(ev('{a b c, d e}%4'), ['0 1/4 a', '0 1/4 d', '1/4 1/4 b', '1/4 1/4 e', '1/2 1/4 c', '1/2 1/4 d', '3/4 1/4 a', '3/4 1/4 e']);
  assert.deepEqual(ev('{a b c, d e}%4', 2, 1), ['1 1/4 b', '1 1/4 d', '5/4 1/4 c', '5/4 1/4 e', '3/2 1/4 a', '3/2 1/4 d', '7/4 1/4 b', '7/4 1/4 e']);
  assert.deepEqual(ev('{a b c}', 2), ['0 1/3 a', '1/3 1/3 b', '2/3 1/3 c', '1 1/3 a', '4/3 1/3 b', '5/3 1/3 c'], 'alone, a sequence');
  assert.deepEqual(ev('{a b c, d e}'), ['0 1/3 a', '0 1/3 d', '1/3 1/3 b', '1/3 1/3 e', '2/3 1/3 c', '2/3 1/3 d'], 'the first layer sets the steps');
  assert.deepEqual(ev('{a b, c d e}%3'), ['0 1/3 a', '0 1/3 c', '1/3 1/3 b', '1/3 1/3 d', '2/3 1/3 a', '2/3 1/3 e']);
  assert.deepEqual(ev('{a b}%4'), ['0 1/4 a', '1/4 1/4 b', '1/2 1/4 a', '3/4 1/4 b']);
  assert.deepEqual(ev('{a b c}%<2 4>', 2), ['0 1/2 a', '1/2 1/2 b', '1 1/4 b', '5/4 1/4 c', '3/2 1/4 a', '7/4 1/4 b']);
  assert.deepEqual(ev('{a b}%2 c'), ['0 1/4 a', '1/4 1/4 b', '1/2 1/2 c']);
  fails('{a b}%x', /expected a number after "%"/);
  fails('{a b}%0', /positive whole number of steps/);
  fails('{a b}%', /expected a number after "%"/);
  fails('{}', /empty sequence/);
});

test('values: words, numbers and note names', () => {
  assert.deepEqual(ev('c3 e3 g3'), ['0 1/3 c3', '1/3 1/3 e3', '2/3 1/3 g3']);
  assert.deepEqual(ev('c#3 db3 cs3 eb3 Bb2 C4'), ['0 1/6 c#3', '1/6 1/6 db3', '1/3 1/6 cs3', '1/2 1/6 eb3', '2/3 1/6 Bb2', '5/6 1/6 C4']);
  assert.deepEqual(mini('0 4 7 60').firstCycle().map((h) => h.value), [0, 4, 7, 60], 'numbers are numbers');
  assert.deepEqual(mini('-1 0.5 1e3 .25').firstCycle().map((h) => h.value), [-1, 0.5, 1000, 0.25]);
  assert.deepEqual(mini('t f 1 0').firstCycle().map((h) => h.value), ['t', 'f', 1, 0]);
  assert.deepEqual(ev('RolandTR909 gm_epiano1 super-saw'), ['0 1/3 RolandTR909', '1/3 1/3 gm_epiano1', '2/3 1/3 super-saw']);
  assert.deepEqual(ev('C:major D:minor'), ['0 1/2 C:major', '1/2 1/2 D:minor']);
});

test('struct reads t, f, 1 and 0 from a string', () => {
  assert.deepEqual(events(pure('x').struct('t ~ t t')), ['0 1/4 x', '1/2 1/4 x', '3/4 1/4 x']);
  assert.deepEqual(events(pure('x').struct('t f 1 0')), ['0 1/4 x', '1/2 1/4 x']);
  assert.deepEqual(events(pure('x').struct('t*2 [t f]')), ['0 1/4 x', '1/4 1/4 x', '1/2 1/4 x']);
  assert.deepEqual(events(pure('x').struct('x ~ x ~')), ['0 1/4 x', '1/2 1/4 x']);
  assert.deepEqual(events(pure('x').fast('<1 2>'), 2), ['0 1 x', '1 1/2 x', '3/2 1/2 x'], 'strings are patterns wherever a pattern is wanted');
});

test('parse errors say where', () => {
  fails('', /empty sequence/);
  fails('[]', /empty sequence at 1:2/);
  fails('[a b', /expected "\]" but found the end at 1:5/);
  fails('a ]', /unexpected "\]" at 1:3/);
  fails('a )', /unexpected "\)" at 1:3/);
  fails('<a b', /expected ">" but found the end/);
  fails('a*', /expected a number after "\*" but found the end/);
  fails('a b (', /empty sequence/);
  fails('a $', /unexpected character "\$" at 1:3/);
  const err = (() => { try { parseMini('a b\n[c d'); } catch (e) { return e as PatternError; } })()!;
  assert.deepEqual(err.position, { offset: 8, line: 2, column: 5 });
});

test('limits: length and depth', () => {
  fails('['.repeat(33) + 'a' + ']'.repeat(33), /nested more than 32 deep/);
  assert.deepEqual(ev('['.repeat(31) + 'a' + ']'.repeat(31)), ['0 1 a']);
  assert.throws(() => mini('a '.repeat(MINI_LIMITS.maxLength)), /longer than/);
  assert.equal(mini('a '.repeat(2000)).firstCycle().length, 2000);
  fails('a!5000', /more than 1024 times/);
  assert.throws(() => mini('a*1000000').firstCycle(), /too many events/);
});

test('the tree', () => {
  assert.deepEqual(parseMini('a'), { type: 'word', value: 'a' });
  assert.deepEqual(parseMini('a b'), { type: 'seq', steps: [{ node: { type: 'word', value: 'a' }, weight: mini('1').firstCycle()[0].duration }, { node: { type: 'word', value: 'b' }, weight: mini('1').firstCycle()[0].duration }] });
  const tree = parseMini('<a b>*2?');
  assert.equal(tree.type, 'degrade');
  assert.equal((tree as { node: { type: string } }).node.type, 'fast');
  assert.ok(mini('a') instanceof Pattern);
});

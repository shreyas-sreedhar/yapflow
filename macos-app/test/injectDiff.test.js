/**
 * Tests for the retraction arithmetic behind non-destructive live typing.
 *
 * This is the logic that replaced a Cmd+A-then-paste fallback. Select-all could
 * not distinguish text we typed from text the user already had in the field, so
 * dictating into a partially-filled field destroyed its contents. The
 * replacement backspaces exactly as many grapheme clusters as we typed — which
 * means the count has to be exactly right, in both directions:
 *
 *   over-count  -> eats the user's surrounding text (the bug we're fixing)
 *   under-count -> leaves stale characters stranded at the cursor
 *
 * Graphemes rather than UTF-16 code units because one backspace in a macOS text
 * field deletes one grapheme cluster. "é" as e+U+0301, a ZWJ emoji family, and a
 * flag are each several code units but one backspace.
 *
 * The two functions are duplicated from src/main.js rather than imported,
 * because main.js requires `electron` at module load and can't be imported
 * outside an Electron process. Keep them in sync — if you change the originals,
 * change these.
 *
 * Run: node test/injectDiff.test.js
 */

'use strict';

const assert = require('assert');

// --- mirrored from src/main.js ---

function graphemeCount(text) {
  if (!text) return 0;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let count = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _segment of segmenter.segment(text)) count++;
    return count;
  }
  return Array.from(text).length;
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  if (i > 0 && i < a.length) {
    const code = a.charCodeAt(i - 1);
    if (code >= 0xd800 && code <= 0xdbff) i--;
  }
  return i;
}

/**
 * What syncInjectedText would do: how many backspaces, and what to type after.
 * Returns { retract, tail, result }.
 */
function plan(injected, target) {
  const prefixLength = commonPrefixLength(injected, target);
  return {
    retract: graphemeCount(injected.slice(prefixLength)),
    tail: target.slice(prefixLength),
    result: injected.slice(0, prefixLength) + target.slice(prefixLength),
  };
}

// --- tests ---

const tests = {
  'pure append types only the delta, retracts nothing'() {
    const p = plan('hello', 'hello world');
    assert.strictEqual(p.retract, 0);
    assert.strictEqual(p.tail, ' world');
    assert.strictEqual(p.result, 'hello world');
  },

  'revised tail retracts only the diverging part'() {
    // Moonshine revising "wreck a nice beach" -> "recognize speech" is the
    // realistic case: a shared prefix, then a different tail.
    const p = plan('I say hello there', 'I say goodbye now');
    assert.strictEqual(p.tail, 'goodbye now');
    assert.strictEqual(p.retract, 'hello there'.length);
    assert.strictEqual(p.result, 'I say goodbye now');
  },

  'no change does nothing'() {
    const p = plan('same text', 'same text');
    assert.strictEqual(p.retract, 0);
    assert.strictEqual(p.tail, '');
  },

  'shortening retracts without typing'() {
    const p = plan('hello world', 'hello');
    assert.strictEqual(p.retract, ' world'.length);
    assert.strictEqual(p.tail, '');
    assert.strictEqual(p.result, 'hello');
  },

  'full retraction to empty (the no-speech / all-filler case)'() {
    const p = plan('um uh', '');
    assert.strictEqual(p.retract, graphemeCount('um uh'));
    assert.strictEqual(p.tail, '');
    assert.strictEqual(p.result, '');
  },

  'from empty types everything'() {
    const p = plan('', 'first words');
    assert.strictEqual(p.retract, 0);
    assert.strictEqual(p.tail, 'first words');
  },

  'completely different text retracts all of ours and nothing more'() {
    const injected = 'abc';
    const p = plan(injected, 'xyz');
    // The critical property: never more backspaces than we typed. One extra
    // would delete a character the user had in the field.
    assert.strictEqual(p.retract, graphemeCount(injected));
    assert.strictEqual(p.tail, 'xyz');
  },

  'emoji counts as one backspace, not two code units'() {
    // '👋' is a surrogate pair: .length === 2, but one backspace deletes it.
    assert.strictEqual('👋'.length, 2);
    assert.strictEqual(graphemeCount('👋'), 1);
    const p = plan('hi 👋', 'hi');
    assert.strictEqual(p.retract, 2); // the space plus the emoji
  },

  'ZWJ emoji sequence counts as one backspace'() {
    const family = '👨‍👩‍👧'; // 8 UTF-16 units, 5 code points, 1 grapheme
    assert.ok(family.length > 1);
    assert.strictEqual(graphemeCount(family), 1);
    assert.strictEqual(graphemeCount(`ok ${family}`), 4);
  },

  'combining accent counts as one backspace'() {
    const decomposed = 'é'; // e + combining acute
    assert.strictEqual(decomposed.length, 2);
    assert.strictEqual(graphemeCount(decomposed), 1);
  },

  'prefix split never lands inside a surrogate pair'() {
    // Shared prefix ends mid-emoji: 'a👋b' vs 'a👋c' share 'a' + the pair.
    const p = plan('a👋b', 'a👋c');
    // The retained prefix must be valid on its own — no lone surrogate.
    const prefix = 'a👋b'.slice(0, commonPrefixLength('a👋b', 'a👋c'));
    assert.ok(!/[\uD800-\uDBFF]$/.test(prefix), 'prefix ends with a lone high surrogate');
    assert.strictEqual(p.result, 'a👋c');
  },

  'divergence immediately after an emoji retracts correctly'() {
    const p = plan('go 👋 now', 'go 👋 later');
    assert.strictEqual(p.result, 'go 👋 later');
    assert.strictEqual(p.tail, 'later');
    assert.strictEqual(p.retract, graphemeCount('now'));
  },

  'newlines from spoken commands round-trip'() {
    const p = plan('line one', 'line one\n\nline two');
    assert.strictEqual(p.retract, 0);
    assert.strictEqual(p.tail, '\n\nline two');
  },

  'plan is always reversible: result equals target'() {
    const pairs = [
      ['', ''],
      ['a', 'b'],
      ['hello', 'hello'],
      ['hello world', 'Hello, world.'],
      ['👋', 'hi 👋 there'],
      ['um so i think', 'So I think'],
      ['multi\nline', 'multi\nline\nmore'],
    ];
    for (const [injected, target] of pairs) {
      assert.strictEqual(plan(injected, target).result, target, `${injected} -> ${target}`);
    }
  },

  'retract never exceeds what we typed'() {
    const pairs = [
      ['abc', 'xyz'],
      ['hello world', 'h'],
      ['👨‍👩‍👧 family', 'nothing alike'],
      ['école', 'school'],
    ];
    for (const [injected, target] of pairs) {
      const p = plan(injected, target);
      assert.ok(
        p.retract <= graphemeCount(injected),
        `retract ${p.retract} > typed ${graphemeCount(injected)} for ${injected} -> ${target}`
      );
    }
  },
};

let failures = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}
process.exit(failures ? 1 : 0);

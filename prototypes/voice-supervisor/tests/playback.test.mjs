import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackQueue } from '../playback.mjs';

test('a ready answer waits for the intro to finish naturally', () => {
  const q = new PlaybackQueue({ charsPerSecond: 10 }); const epoch = q.begin('one');
  q.offer({ turnId: 'one', role: 'answer', text: '正式回答。', epoch });
  q.advance(100); assert.equal(q.playing, null);
  q.offer({ turnId: 'one', role: 'intro', text: '收到。', epoch });
  q.advance(100); assert.equal(q.playing.role, 'intro');
  q.advance(300); assert.equal(q.playing.role, 'answer');
  assert.equal(q.events[1].type, 'completed');
  assert.equal(q.events[2].role, 'answer');
  assert.equal(q.events[1].at, q.events[2].at);
});
test('button interruption keeps only the played Unicode prefix and rejects late audio', () => {
  const q = new PlaybackQueue({ charsPerSecond: 10 }); const epoch = q.begin('one');
  q.offer({ turnId: 'one', role: 'intro', text: '好。', epoch });
  const id = q.offer({ turnId: 'one', role: 'answer', text: '甲😀乙丙。', epoch });
  q.advance(410); const receipt = q.interrupt();
  const answer = receipt.outputs.find(o => o.outputId === id);
  assert.equal(answer.playedText, '甲😀'); assert.equal(answer.unplayedText, '乙丙。');
  assert.equal(q.offer({ turnId: 'one', role: 'answer', text: '旧音频', epoch }), null);
  q.advance(1000); assert.equal(q.playing, null);
});
test('front failure releases the queued answer without inventing an intro', () => {
  const q = new PlaybackQueue({ charsPerSecond: 10 }); const epoch = q.begin('one');
  q.offer({ turnId: 'one', role: 'answer', text: '答案', epoch }); q.failIntro('one');
  q.advance(0); assert.equal(q.playing.role, 'answer');
});
test('queued old speech cannot leak into the next input epoch', () => {
  const q = new PlaybackQueue({ charsPerSecond: 10 }); const epoch = q.begin('one');
  q.offer({ turnId: 'one', role: 'intro', text: '旧接话', epoch }); q.interrupt();
  const fresh = q.begin('two'); q.offer({ turnId: 'two', role: 'intro', text: '新接话', epoch: fresh });
  q.advance(100); assert.equal(q.playing.text, '新接话');
  assert.equal(q.delivery()[0].state, 'dropped');
});
test('invalid and duplicate offers fail without reopening a finished intro', () => {
  const q = new PlaybackQueue({ charsPerSecond: 10 }); const epoch = q.begin('one');
  assert.throws(() => q.begin('one')); assert.throws(() => q.advance(-1));
  assert.throws(() => q.offer({ turnId: 'unknown', role: 'answer', text: 'x', epoch }));
  q.offer({ turnId: 'one', role: 'intro', text: '好', epoch });
  assert.throws(() => q.offer({ turnId: 'one', role: 'intro', text: '重复', epoch }));
});

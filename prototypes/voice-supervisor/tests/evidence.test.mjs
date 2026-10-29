import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerPhase } from '../events.mjs';

test('a progress message quoting the final label is not a final answer', () => {
  assert.equal(answerPhase('【进度】完成后我会用【结果】告诉你。'), 'progress');
  assert.equal(answerPhase('我会随后报告【结果】。'), 'initial');
  assert.equal(answerPhase(' **【结果】校验完成。'), 'final');
});
test('the real-run evidence contains a parent answer between child start and end', () => {
  const events = JSON.parse(readFileSync(new URL('../docs/evidence/trace.json', import.meta.url), 'utf8'));
  const started = events.find(e => e.type === 'child.started');
  const ended = events.find(e => e.type === 'child.ended');
  const progress = events.find(e => e.text && answerPhase(e.text) === 'progress');
  const final = events.find(e => e.sessionId === progress.sessionId && e.text && answerPhase(e.text) === 'final');
  assert.ok(started.time < progress.time && progress.time < ended.time);
  const workerResults = events.filter(e => e.sessionId === started.sessionId && e.nativeType === 'tool/result');
  assert.ok(workerResults.length > 0);
  assert.ok(final.time >= workerResults.at(-1).time);
  assert.notEqual(progress.sessionId, started.sessionId);
  assert.equal(final.sessionId, progress.sessionId);
});
test('the final real answer includes the independently checked artifact, not a quoted marker', () => {
  const result = JSON.parse(readFileSync(new URL('../docs/evidence/live-result.json', import.meta.url), 'utf8'));
  assert.equal(result.success, true);
  assert.equal(answerPhase(result.final), 'final');
  assert.ok(result.final.includes(result.artifact.sha256));
  const partial = result.delivery.outputs.find(o => o.state === 'interrupted');
  assert.equal(partial.playedText + partial.unplayedText, result.initial);
  assert.ok(result.progress.includes(partial.playedText));
});

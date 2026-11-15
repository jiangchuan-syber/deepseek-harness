import test from 'node:test';
import assert from 'node:assert/strict';
import { controlSnapshot, controlView, controlQuery, controlResult } from '../control-view.mjs';
import { traceState } from '../trace.mjs';

const fact = (commandId = 'command-1') => ({ commandId, voiceSessionId: 'voice-1', resourceId: 'lamp-1',
  clockId: 'controller-1', goalVersion: 1, status: 'verified', intent: { target: 'lamp', property: 'power', value: false },
  currentGoal: true, writeAttempted: true, writeAcknowledged: true, elapsedMs: 31,
  readback: { resourceId: 'lamp-1', queryId: 'fresh-query', fresh: true, properties: { power: false } } });

test('trace snapshot includes bounded controller facts with source and cursor', () => {
  const controls = Array.from({ length: 300 }, (_, i) => fact('command-' + i));
  const result = traceState({ status: 'idle', controlSourceInstance: 'controller-1', controlSequence: 999, controls });
  assert.equal(result.controls.length, 256);
  assert.equal(result.controls[0].commandId, 'command-44');
  assert.equal(result.controls.at(-1).requestId, 'command-299');
  assert.deepEqual(result.controlProjection, { schemaVersion: 1, sourceInstance: 'controller-1', sequence: 999 });
  assert.equal(result.controls.at(-1).readback.queryId, 'fresh-query');
});

test('program facts cannot leak provider inventory or pretend to be a model tool call', () => {
  const result = controlView({ ...fact(), token: 'private-token', address: 'private-address',
    arguments: 'private-arguments', tool_call_id: 'private-tool', lastAssistantMessage: 'private-model' });
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(result.origin, 'program-control');
  assert.equal(result.physicalEffectVerified, false);
});

test('malformed state has no controls and old goal facts remain old', () => {
  assert.equal(controlView({ ...fact(), intent: { target: 'lamp', property: 'power', value: 'off' } }), undefined);
  const current = controlSnapshot({ controls: [{ ...fact(), currentGoal: false }], controlSequence: -1 });
  assert.equal(current.controls[0].currentGoal, false);
  assert.equal(current.controlProjection.sequence, 0);
  assert.deepEqual(controlSnapshot({ controls: {} }).controls, []);
});

test('exact result inspection keeps original scope and rejects ambiguous command queries', () => {
  const original = { ...fact(), currentGoal: false };
  let reads = 0;
  const lane = { clockId: 'new-controller', get: id => { reads++; return id === 'command-1' ? original : undefined; } };
  const result = controlResult(lane, controlQuery(new URLSearchParams('commandId=command-1')), 9);
  assert.equal(reads, 1); assert.equal(result.found, true);
  assert.equal(result.control.commandId, 'command-1'); assert.equal(result.control.clockId, 'controller-1');
  assert.equal(result.control.goalVersion, 1); assert.equal(result.control.currentGoal, false);
  assert.equal(result.sourceInstance, 'new-controller');
  assert.equal(controlResult(lane, 'unknown-command', 9).found, false);
  for (const query of ['', 'commandId=a&commandId=b', 'commandId=a&other=b', 'commandId=../secret', 'other=command-1']) {
    assert.throws(() => controlQuery(new URLSearchParams(query)), /Exactly one valid commandId/);
  }
});

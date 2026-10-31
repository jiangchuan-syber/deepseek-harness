import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeTrace, traceState } from '../trace.mjs';

function event(type, data, sessionId = 'parent') {
  return { type: 'session', time: 123, sequence: 7, data: { sessionId, event: { type, seq: 9, data } } };
}
test('trace exposes visible text without thinking blocks', () => {
  const result = nativeTrace(event('assistant/message', { message: { content: [
    { type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: '实际结果' }] } }), 'parent');
  assert.equal(result.text, '实际结果');
  assert.ok(!JSON.stringify(result).includes('private reasoning'));
});
test('delegation retains exact prompt, tool call ID and native sequence', () => {
  const result = nativeTrace(event('tool/call', { name: 'subagent', callId: 'call-1',
    arguments: JSON.stringify({ prompt: '校验文件，不修改', description: '校验' }) }), 'parent');
  assert.equal(result.kind, 'task.dispatch'); assert.equal(result.callId, 'call-1');
  assert.equal(result.details.prompt, '校验文件，不修改'); assert.equal(result.nativeEventSequence, 9);
});
test('child message delivery is distinguished from child completion', () => {
  const relay = nativeTrace(event('user/message', { content: [{ type: 'text', text: '已校验' }],
    source: { kind: 'agent-message', senderSessionId: 'child' } }), 'parent');
  assert.equal(relay.kind, 'child.relay'); assert.equal(relay.childId, 'child');
  const ended = nativeTrace({ type: 'child.ended', time: 150, data: { id: 'child', stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: '结果' }] } }, 'parent');
  assert.equal(ended.kind, 'child.ended'); assert.equal(ended.text, '结果');
  assert.equal(nativeTrace(event('user/message', { source: { kind: 'time-context' } }), 'parent'), null);
});
test('status observations do not leak full child message contents', () => {
  const state = traceState({ sessionId: 'parent', status: 'idle', children: [{ id: 'child', ended: true,
    lastAssistantMessage: [{ type: 'thinking', thinking: 'private reasoning' }], stopReason: 'completed' }] });
  assert.equal(state.children[0].id, 'child'); assert.equal(state.children[0].ended, true);
  assert.ok(!JSON.stringify(state).includes('private reasoning'));
});

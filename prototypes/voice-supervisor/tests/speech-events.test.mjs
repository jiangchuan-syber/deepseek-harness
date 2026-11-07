import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechEvents } from '../speech-events.mjs';
import { EventEmitter } from 'node:events';

test('visible deltas have stable cursors and expired readers fail closed', () => {
  const stream = new SpeechEvents(2);
  for (let i=0; i<3; ++i) stream.push({ kind: 'delta', outputId: 'synthetic', text: '测试' });
  assert.deepEqual(stream.events.map(e => e.sequence), [2, 3]);
  let status;
  stream.subscribe(0, { writeHead(code) { status=code; }, end() {} });
  assert.equal(status, 410);
});
test('idle subscribers receive a connection frame immediately and release on close', () => {
  const stream = new SpeechEvents();
  const response = new EventEmitter(); const writes = [];
  response.writeHead = () => {};
  response.write = text => { writes.push(text); return true; };
  stream.subscribe(0, response);
  assert.deepEqual(writes, [': connected\n\n']);
  response.emit('close');
  assert.equal(stream.clients.size, 0);
});
test('native exit refuses new readers rather than advertising a healthy idle stream', () => {
  const stream = new SpeechEvents(); stream.close();
  let status;
  stream.subscribe(0, { writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 503);
});

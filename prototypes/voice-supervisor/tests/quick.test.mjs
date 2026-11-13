import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QUICK_SYSTEM, quickInput, shortReply, QuickLane } from '../quick.mjs';
import { StageQueue } from '../stages.mjs';
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('quick request uses only the newest bounded conversation and independent system', () => {
  const input = quickInput([{role:'用户',text:'OLD'.repeat(500)},{role:'助手',text:'recent answer'}], 'new question', {contextChars:30,inputChars:6});
  assert.equal(input.system, QUICK_SYSTEM);
  assert.equal(input.historyChars, 30); assert.equal(input.inputChars, 6);
  assert.match(input.messages[0].content[0].text, /助手：recent answer/);
  assert.ok(input.messages[0].content[0].text.endsWith('estion'));
  assert.equal(input.tools, undefined);
});

test('short output stops at a natural ending, hides markup and caps Unicode characters', () => {
  assert.deepEqual(shortReply('', '好的，我看看。后面不说',30),{text:'好的，我看看。',done:true});
  assert.deepEqual(shortReply('好的','<｜DSML',30),{text:'好的',done:true});
  const result=shortReply('', '😀'.repeat(40),30);
  assert.equal(Array.from(result.text).length,30);assert.ok(result.text.endsWith('。'));
});

test('quick replies honor small Unicode caps without protecting a fixed opening', () => {
  assert.deepEqual(shortReply('', '好的，马上检查。', 30), { text: '好的，马上检查。', done: true });
  assert.deepEqual(shortReply('', '马上检查。', 2), { text: '马。', done: true });
  assert.deepEqual(shortReply('', '😀马上检查。', 3), { text: '😀马。', done: true });
});

test('a stop before usable text stays empty instead of fabricating speech', () => {
  assert.deepEqual(shortReply('', '<｜DSML', 30), { text: '', done: true });
  assert.deepEqual(shortReply('', '\n后面的话', 30), { text: '', done: true });
  assert.deepEqual(shortReply('', '，。！', 30), { text: '', done: true });
  assert.deepEqual(shortReply('', '  ', 30), { text: '', done: false });
  assert.deepEqual(shortReply('', '，好的，我看看。', 30), { text: '好的，我看看。', done: true });
});

test('quick system is brief and allows natural acknowledgement without routing', () => {
  assert.ok(Array.from(QUICK_SYSTEM).length <= 200);
  assert.ok(!QUICK_SYSTEM.includes('我在'));
  assert.ok(QUICK_SYSTEM.includes('好的，我立刻处理'));
  assert.match(QUICK_SYSTEM, /不路由分派/u);
  assert.match(QUICK_SYSTEM, /不声称已执行完成/u);
});

test('quick acknowledgement completes while main deep processing is blocked', async () => {
  const started=barrier(), release=barrier(), second=barrier(), events=[];
  const main=new StageQueue({observe(){},run:async(phase,job)=>{
    assert.equal(phase,'thinking');if(job.requestId==='a'){started.resolve();await release.promise;}
  }});
  const lane=new QuickLane({capacity:4,observe(){},run:async job=>{events.push(job.requestId);return '收到。';},
    settle:job=>{main.enqueue(job,{quickDone:true});if(job.requestId==='b')second.resolve();}});
  lane.enqueue({requestId:'a'});await started.promise;
  lane.enqueue({requestId:'b'});await second.promise;
  assert.deepEqual(events,['a','b']);assert.equal(main.snapshot().phase,'thinking');
  assert.equal(main.snapshot().pendingContinuations,1);
  release.resolve();await lane.close();await main.close();
});

test('failed quick call remains visible and still forwards original user request to main', async () => {
  const settled=[],seen=[];
  const lane=new QuickLane({capacity:2,observe:(kind)=>seen.push(kind),run:async()=>{throw new Error('Unavailable');},settle:job=>settled.push(job)});
  lane.enqueue({requestId:'x',text:'original'});await lane.running;
  assert.equal(settled[0].text,'original');assert.equal(settled[0].quickReply,'');
  assert.ok(seen.includes('quick.failed'));assert.throws(()=>lane.enqueue({requestId:'x'}),/Duplicate/);
  await lane.close();
});

test('quick shutdown aborts its owned request and never dispatches a continuation', async () => {
  const started=barrier();let settled=0;
  const lane=new QuickLane({capacity:2,observe(){},settle:()=>settled++,run:async(_job,controller)=>{
    started.resolve();await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));return 'done';}});
  lane.enqueue({requestId:'x'});await started.promise;await lane.close();assert.equal(settled,0);
});

test('failed durable quick admission does not execute or reserve the request', () => {
  let calls=0;
  const lane=new QuickLane({capacity:2,observe(){throw new Error('disk');},run(){calls++;},settle(){}});
  assert.throws(()=>lane.enqueue({requestId:'x'}),/disk/);assert.equal(calls,0);assert.equal(lane.seen.size,0);
});


test('bounded quick request matches its keyless model-visible snapshot', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/quick-request.json', import.meta.url), 'utf8'));
  assert.deepEqual(quickInput([{role:'用户',text:'在吗？'},{role:'助手',text:'在的。'}], '你好',
    {contextChars:1200,inputChars:600}), expected);
});

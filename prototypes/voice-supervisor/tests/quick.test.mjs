import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { QUICK_SYSTEM, quickInput, shortReply, QuickLane } from '../quick.mjs';
import { StageQueue } from '../stages.mjs';
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function within(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 150); })]); }
  finally { clearTimeout(timer); }
}

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

test('new turns retire same-parent queued acknowledgements and abort only their running quick call', async () => {
  const started = barrier(), cleanup = barrier(), calls = [], settled = [], observations = [];
  let oldController, oldIsCurrent, active = 0, maximum = 0;
  const lane = new QuickLane({ capacity: 2, scopeOf: job => job.parent,
    observe: (kind, job) => observations.push([kind, job.requestId]), settle: job => settled.push(job),
    run: async (job, controller, isCurrent) => {
      calls.push(job.requestId); maximum = Math.max(maximum, ++active);
      try {
        if (job.requestId === 'old') { oldController = controller; oldIsCurrent = isCurrent; started.resolve(); await cleanup.promise; }
        return 'provider text'; // Even a provider that returns after abort cannot settle stale text.
      } finally { active--; }
    } });
  lane.enqueue({ requestId: 'old', parent: 'parent-a', text: 'keep original old goal' });
  await started.promise;
  lane.enqueue({ requestId: 'middle', parent: 'parent-a', text: 'keep middle goal' });
  lane.enqueue({ requestId: 'latest', parent: 'parent-a', text: 'keep latest goal' });
  assert.equal(oldController.signal.aborted, true);
  assert.equal(oldController.signal.reason.code, 'QUICK_SUPERSEDED');
  assert.equal(oldIsCurrent(), false);
  assert.deepEqual(calls, ['old']); // Wait for resource cleanup; do not spawn overlapping requests.
  assert.equal(settled.find(job => job.requestId === 'middle').quickReply, '');
  cleanup.resolve(); await lane.running;
  assert.deepEqual(calls, ['old', 'latest']); assert.equal(maximum, 1);
  assert.equal(settled.find(job => job.requestId === 'old').quickReply, '');
  assert.equal(settled.find(job => job.requestId === 'old').text, 'keep original old goal');
  assert.equal(settled.find(job => job.requestId === 'latest').quickOutcome, 'completed');
  assert.equal(settled.filter(job => job.quickOutcome === 'superseded').length, 2);
  assert.ok(!observations.some(([kind]) => kind === 'quick.failed'));
  await lane.close();
});

test('different parent scope is neither aborted nor removed by a newer turn', async () => {
  const started = barrier(), release = barrier(), calls = [], settled = [];
  let firstController;
  const lane = new QuickLane({ capacity: 3, scopeOf: job => job.parent, observe() {}, settle: job => settled.push(job),
    run: async (job, controller) => {
      calls.push(job.requestId);
      if (job.requestId === 'one') { firstController = controller; started.resolve(); await release.promise; }
      return 'reply';
    } });
  lane.enqueue({ requestId: 'one', parent: 'a' }); await started.promise;
  lane.enqueue({ requestId: 'two', parent: 'b' });
  assert.equal(firstController.signal.aborted, false);
  lane.enqueue({ requestId: 'three', parent: 'a' });
  assert.equal(firstController.signal.aborted, true);
  release.resolve(); await lane.running;
  assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.equal(settled.find(job => job.requestId === 'two').quickOutcome, 'completed');
  await lane.close();
});

test('scope retirement leaves a running native deep phase in progress', async () => {
  const deepStarted = barrier(), releaseDeep = barrier(), quickStarted = barrier(), releaseQuick = barrier();
  let deepCompleted = false;
  const main = new StageQueue({ observe() {}, run: async () => {
    deepStarted.resolve(); await releaseDeep.promise; deepCompleted = true;
  } });
  main.enqueue({ requestId: 'background' }, { quickDone: true }); await deepStarted.promise;
  const lane = new QuickLane({ capacity: 2, scopeOf: job => job.parent, observe() {}, settle: job => main.enqueue(job, { quickDone: true }),
    run: async job => { if (job.requestId === 'old') { quickStarted.resolve(); await releaseQuick.promise; } return '收到。'; } });
  lane.enqueue({ requestId: 'old', parent: 'same' }); await quickStarted.promise;
  lane.enqueue({ requestId: 'new', parent: 'same' }); releaseQuick.resolve(); await lane.running;
  assert.equal(main.snapshot().phase, 'thinking'); assert.equal(deepCompleted, false);
  assert.equal(main.snapshot().pendingContinuations, 2);
  releaseDeep.resolve(); await lane.close(); await main.close();
  assert.equal(deepCompleted, true);
});

test('an abort-ignoring quick request cannot indefinitely hold the next turn', async () => {
  const oldStarted = barrier(), releaseOld = barrier(), latestStarted = barrier();
  const lane = new QuickLane({ capacity: 2, cancelGraceMs: 10, maxOutstanding: 2,
    scopeOf: job => job.parent, observe() {}, settle() {},
    run: async job => {
      if (job.requestId === 'stuck') { oldStarted.resolve(); await releaseOld.promise; }
      else latestStarted.resolve();
      return 'provider text';
    } });
  try {
    lane.enqueue({ requestId: 'stuck', parent: 'same' }); await oldStarted.promise;
    lane.enqueue({ requestId: 'latest', parent: 'same' });
    await within(latestStarted.promise, 'new turn remained behind an abort-ignoring provider');
  } finally { releaseOld.resolve(); await lane.close(); }
});

test('two unresolved provider calls reject a third quick honestly and retain its original goal', async () => {
  const first = barrier(), second = barrier(), thirdSettled = barrier(), release = barrier();
  const called = [], settled = [], failures = [];
  const lane = new QuickLane({ capacity: 3, cancelGraceMs: 5, maxOutstanding: 2,
    scopeOf: job => job.parent, observe: (kind, job, detail) => { if (kind === 'quick.failed') failures.push([job.requestId, detail.errorType]); },
    settle: job => { settled.push(job); if (job.requestId === 'third') thirdSettled.resolve(); },
    run: async job => {
      called.push(job.requestId); (job.requestId === 'first' ? first : second).resolve();
      await release.promise; return 'late';
    } });
  try {
    lane.enqueue({ requestId: 'first', parent: 'same' }); await first.promise;
    lane.enqueue({ requestId: 'second', parent: 'same' });
    await within(second.promise, 'second quick did not start');
    lane.enqueue({ requestId: 'third', parent: 'same', text: 'preserve this goal' });
    await within(thirdSettled.promise, 'busy result was not reported');
    assert.deepEqual(called, ['first', 'second']); assert.equal(lane.controllers.size, 2);
    const result = settled.find(job => job.requestId === 'third');
    assert.equal(result.quickOutcome, 'cleanup_blocked'); assert.equal(result.quickReply, '');
    assert.equal(result.text, 'preserve this goal'); assert.deepEqual(failures, [['third', 'QuickCleanupBusyError']]);
  } finally { release.resolve(); await lane.close(); }
  assert.equal(lane.controllers.size, 0); assert.equal(lane.retired.size, 0);
});

test('shutdown awaits owned retired cleanup instead of claiming it already finished', async () => {
  const old = barrier(), latest = barrier(), release = barrier(); let closed = false;
  const lane = new QuickLane({ capacity: 2, cancelGraceMs: 5, maxOutstanding: 2,
    scopeOf: job => job.parent, observe() {}, settle() {}, run: async job => {
      if (job.requestId === 'old') { old.resolve(); await release.promise; } else latest.resolve();
      return 'reply';
    } });
  lane.enqueue({ requestId: 'old', parent: 'same' }); await old.promise;
  lane.enqueue({ requestId: 'latest', parent: 'same' }); await latest.promise;
  const closing = lane.close().then(() => { closed = true; });
  await delay(15); assert.equal(closed, false);
  release.resolve(); await closing;
  assert.equal(lane.owned.size, 0); assert.equal(lane.controllers.size, 0);
});

test('diagnostics share owned slots, reject overlap and yield to a real parent input', async () => {
  const probeStarted = barrier(), releaseProbe = barrier(), realStarted = barrier(); let probeSignal;
  const lane = new QuickLane({ capacity: 2, cancelGraceMs: 5, maxOutstanding: 2,
    scopeOf: job => job.parent, observe() {}, settle() {}, run: async () => { realStarted.resolve(); return 'real'; } });
  const probing = lane.probe({ requestId: 'probe', parent: 'same' }, async (_job, controller) => {
    probeSignal = controller.signal; probeStarted.resolve(); await releaseProbe.promise; return 'measurement';
  });
  const rejectedProbe = assert.rejects(probing, /superseded/);
  try {
    await probeStarted.promise;
    await assert.rejects(lane.probe({ requestId: 'second-probe', parent: 'same' }, () => 'unexpected'), /idle/);
    lane.enqueue({ requestId: 'real', parent: 'same' });
    await within(realStarted.promise, 'diagnostic blocked real input');
    assert.equal(probeSignal.aborted, true); assert.ok(lane.controllers.size <= 2);
    await assert.rejects(lane.probe({ requestId: 'third-probe', parent: 'same' }, () => 'unexpected'), /idle/);
  } finally { releaseProbe.resolve(); await rejectedProbe; await lane.close(); }
});

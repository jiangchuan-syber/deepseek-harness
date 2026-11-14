/** Actual Cordis policy/observations only; no fake parent, child or tool service. */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const name = 'native-brief-fixture-policy';
export const inject = ['tools'];
/** Authenticate the controller's own private IPC exit request, never model input. */
export function isOwnedStop(message, nonce) {
  return message !== null && typeof message === 'object' && !Array.isArray(message)
    && Object.keys(message).length === 2 && message.type === 'voice-native-fixture-stop'
    && typeof nonce === 'string' && nonce.length >= 16 && message.nonce === nonce;
}
/** Attach an owned IPC callback to the real Cordis fiber's disposal. */
export function bindOwnedStop(ctx, nonce, stop, cleanup) {
  return ctx.effect(() => {
    const receive = message => { if (isOwnedStop(message, nonce)) stop(); };
    process.on('message', receive);
    return () => { process.off('message', receive); cleanup(); };
  });
}
export function apply(ctx) {
  // Real launcher commits this service only after boot() and all profile mounts
  // succeed (apps/cli/src/profile-boot.ts). Plugin readyFile is earlier.
  const ready = ctx.get('appReady');
  if (!ready?.onReady) throw new Error('Actual launcher appReady service is required');
  const off = ready.onReady(() => writeFileSync(join(process.env.VOICE_NATIVE_FIXTURE_ROOT,
    'native-app-ready.json'), JSON.stringify({ launcherCommitted: true })));
  ctx.effect(() => off);
  if (process.listenerCount('SIGTERM') < 1) throw new Error('Actual launcher SIGTERM handler is required');
  const stop = () => {
    writeFileSync(join(process.env.VOICE_NATIVE_FIXTURE_ROOT, 'native-app-exit-request.json'),
      JSON.stringify({ actualLauncherExitRequested: true, standardSigtermEmitted: true,
        standardSignalHandlerPresent: process.listenerCount('SIGTERM') > 0 }));
    // Same in-process signal entry used by the repository's real Web CLI IPC
    // fixture; Windows child.kill(SIGTERM) would terminate instead of emitting it.
    process.emit('SIGTERM');
  };
  bindOwnedStop(ctx, process.env.VOICE_NATIVE_STOP_NONCE, stop, () => {
    writeFileSync(join(process.env.VOICE_NATIVE_FIXTURE_ROOT, 'native-ipc-disposed.json'),
      JSON.stringify({ ownedListenerRemoved: true }));
    if (process.connected) process.disconnect();
  });
  ctx.tools.guard(exec => exec.name === 'subagent' ? undefined : 'Fixture permits only actual native subagent dispatch');
  ctx.on('session/event', (session, event) => {
    if (['tool/call', 'tool/result', 'assistant/message', 'user/message', 'agent/inbox/inserted', 'agent/inbox/spliced', 'turn/end'].includes(event.type)) {
      appendFileSync(join(process.env.VOICE_NATIVE_FIXTURE_ROOT, 'native-events.jsonl'), JSON.stringify({
        sessionId: session.id, event }) + '\n');
    }
  }, { global: true });
}

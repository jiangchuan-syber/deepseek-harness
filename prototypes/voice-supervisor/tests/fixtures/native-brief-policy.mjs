/** Actual Cordis policy/observations only; no fake parent, child or tool service. */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const name = 'native-brief-fixture-policy';
export const inject = ['tools'];
export function apply(ctx) {
  // Real launcher commits this service only after boot() and all profile mounts
  // succeed (apps/cli/src/profile-boot.ts). Plugin readyFile is earlier.
  const ready = ctx.get('appReady');
  if (!ready?.onReady) throw new Error('Actual launcher appReady service is required');
  const off = ready.onReady(() => writeFileSync(join(process.env.VOICE_NATIVE_FIXTURE_ROOT,
    'native-app-ready.json'), JSON.stringify({ launcherCommitted: true })));
  ctx.on('dispose', off);
  ctx.tools.guard(exec => exec.name === 'subagent' ? undefined : 'Fixture permits only actual native subagent dispatch');
  ctx.on('session/event', (session, event) => {
    if (['tool/call', 'tool/result', 'assistant/message', 'user/message', 'agent/inbox/inserted', 'agent/inbox/spliced', 'turn/end'].includes(event.type)) {
      appendFileSync(join(process.env.VOICE_NATIVE_FIXTURE_ROOT, 'native-events.jsonl'), JSON.stringify({
        sessionId: session.id, event }) + '\n');
    }
  }, { global: true });
}

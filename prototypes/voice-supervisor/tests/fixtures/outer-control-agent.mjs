/** Keyless real Agent loop and tool executor, isolated from the native launcher. */
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Mount the actual loop and policy pipeline with only synthetic model responses. */
export async function controlAgent(fixtureRoot, evidence, save) {
  const root = new Context();
  evidence.modelRequests = []; evidence.toolExecutions = []; evidence.toolResults = [];
  const used = new Set();
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model,
      reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' } }; }
    async *stream(request) {
      const user = request.messages.filter(message => message.role === 'user').at(-1);
      const reportOnly = user?.content.some(block => block.type === 'text' && block.text.startsWith('这是程序执行事实'));
      const first = !used.has(user?.id); used.add(user?.id);
      evidence.modelRequests.push({ userId: user?.id, reportOnly, first,
        tools: request.tools?.map(tool => tool.name) ?? [] }); save();
      if (first) {
        const names = reportOnly ? ['fixture_repeat_control', 'fixture_local_control', 'fixture_delegate'] : ['fixture_normal_task'];
        for (const [index, name] of names.entries()) {
          const id = ToolCallId('fixture-' + evidence.modelRequests.length + '-' + index);
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: '{}' } };
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = reportOnly ? '操作结果尚未确认。' : '研究任务完成。';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, NativeToolExecutor, AgentRegistry]) {
    await root.plugin(plugin);
  }
  await root.plugin(AgentLoop, { agents: [] });
  root.llm.registerAdapter(['deepseek-official'], new FixtureAdapter());
  const definition = name => defineTool({ name, description: 'Owned offline fixture capability.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      evidence.toolExecutions.push(name);
      if (name.endsWith('control')) {
        const file = join(fixtureRoot, 'broker-state.json');
        const state = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...state, writes: (state.writes ?? 0) + 1 }));
      }
      save(); return 'fixture completed';
    } });
  for (const name of ['fixture_repeat_control', 'fixture_delegate', 'fixture_normal_task']) root.tools.register(definition(name));
  const actual = await root.agentLoop.create(SessionId('outer-fixture-real-parent'),
    { provider: 'deepseek-official', model: 'fixture-parent-model' });
  actual.ctx.tools.register(definition('fixture_local_control'));
  root.on('session/event', (session, event) => {
    if (session.id === actual.id && event.type === 'tool/result') {
      evidence.toolResults.push(event.data.message); save();
    }
  }, { global: true });
  let cancelled = false;
  const parent = new Proxy(actual, { get(target, key) {
    if (key === 'status' && !existsSync(join(fixtureRoot, 'release-max'))) return 'running';
    if (key === 'whenIdle') return async () => {
      while (!existsSync(join(fixtureRoot, 'release-max'))) {
        if (cancelled) throw new Error('Owned fixture shutdown');
        await delay(10);
      }
      return target.whenIdle();
    };
    if (key === 'cancel') return cause => { cancelled = true; return target.cancel(cause); };
    if (key === 'inject') return message => { evidence.injections.push(message); save(); return target.inject(message); };
    if (key === 'steer') return message => { evidence.steers++; save(); return target.steer(message); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { parent, root, close: () => root.fiber.dispose() };
}

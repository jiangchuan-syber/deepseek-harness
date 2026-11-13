import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./miio-lamp-broker.py', import.meta.url));
const failure = (code, outcome = 'not_started') => Object.assign(new Error(code), { name: 'ControlProviderError', code, outcome });

/** Private broker adapter. Only execute mode can admit an actuator request; it is disabled by default. */
export class MiioLampProvider {
  constructor(config = {}) {
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw failure('invalid_provider_enabled');
    this.config = config; this.ownerId = randomUUID(); this.child = null; this.ready = null;
    this.starting = null; this.active = null; this.tail = Promise.resolve(); this.closed = false;
    this.freshRead = false; this.stderrBytesDropped = 0; this.mode = config.mode ?? 'read-only';
    if (config.enabled === true) {
      if (!config.python || !config.workspace || !/^[a-f0-9]{16}$/.test(config.expectedLampHash ?? '')) throw failure('invalid_provider_identity_config');
      for (const key of ['operationLimitMs', 'startupTimeoutMs', 'closeTimeoutMs']) {
        if (!Number.isFinite(config[key]) || config[key] <= 0) throw failure('invalid_provider_' + key);
      }
      if (!['read-only', 'dry-run', 'execute'].includes(this.mode)) throw failure('invalid_provider_mode');
      if (this.mode === 'execute' && (config.allowWrite !== true || config.cooperativeControlReady !== true)) throw failure('cooperative_write_path_not_ready');
    }
  }
  async start() {
    if (this.config.enabled !== true) throw failure('provider_disabled');
    if (this.closed) throw failure('provider_closed');
    if (this.ready) return this.ready;
    if (this.starting) return this.starting;
    const args = [script, '--workspace', this.config.workspace, '--expected-lamp-hash', this.config.expectedLampHash,
      '--owner-id', this.ownerId, '--mode', this.mode, '--operation-limit-ms', String(this.config.operationLimitMs)];
    if (this.mode === 'execute') args.push('--allow-write');
    if (this.config.fixture) args.push('--fixture', this.config.fixture);
    const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const child = spawn(this.config.python, args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.freshRead = false;
    child.ownerExit = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    let buffer = '';
    const startupTimer = setTimeout(() => { rejectReady(failure('broker_startup_timeout')); void this.terminate(child); }, this.config.startupTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) { rejectReady(failure('broker_frame_too_large')); void this.terminate(child); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { rejectReady(failure('invalid_broker_json')); void this.terminate(child); return; }
        if (value.kind === 'ready') {
          if (value.protocol !== 1 || value.ownerId !== this.ownerId || value.didHash !== this.config.expectedLampHash
              || value.model !== 'yeelink.light.lamp27' || value.mode !== this.mode
              || value.resourceId !== 'miio-lamp-' + this.config.expectedLampHash
              || !/^[a-f0-9]{64}$/.test(value.homeHash ?? '')
              || (!this.config.fixture && value.sharedGuardProtocol !== 1)
              || value.transport !== (this.config.fixture ? 'fixture' : 'miio')) {
            rejectReady(failure('broker_identity_mismatch')); void this.terminate(child); return;
          }
          this.ready = value; resolveReady(value);
        } else if (value.kind === 'startup-error') rejectReady(failure(value.code));
        else this.onMessage(value, child);
      }
    });
    child.stderr.on('data', data => { this.stderrBytesDropped += data.length; });
    child.stdin.on('error', () => {}); // Exit owns error settlement; never print private stdio.
    child.once('error', () => {
      if (this.child === child) { this.child = null; this.ready = null; }
      rejectReady(failure('broker_spawn_failed'));
    });
    child.once('exit', () => {
      if (this.child === child) { this.child = null; this.ready = null; this.freshRead = false; }
      rejectReady(failure('broker_exited_before_ready'));
      const job = this.active;
      if (job?.child === child && !job.expiring) job.finish(failure('broker_exited', job.granted ? 'unknown' : 'not_started'));
    });
    this.starting = ready.finally(() => { clearTimeout(startupTimer); this.starting = null; });
    return this.starting;
  }
  resolve(intent) {
    if (intent.target !== 'lamp' || intent.property !== 'power') return null;
    return { approved: this.mode === 'execute' && this.config.allowWrite === true && this.freshRead,
      unique: !!this.ready, homeSuffix: '3625', resourceId: this.ready?.resourceId, properties: ['power'] };
  }
  onMessage(value, child) {
    const job = this.active;
    if (!job || job.child !== child || value.id !== job.id || job.expiring) return;
    if (value.kind === 'write-ready') {
      let current = false;
      try { current = job.context.isCurrent?.() === true; } catch { /* A failed goal check never authorizes. */ }
      const binding = value.commandId === job.commandId && value.goalVersion === job.context.goalVersion
        && value.resourceId === this.ready?.resourceId && value.ownerId === this.ownerId;
      const allowed = binding && current && !job.context.signal?.aborted && performance.now() < job.context.deadline;
      job.granted = allowed;
      child.stdin.write(JSON.stringify({ kind: allowed ? 'authorize' : 'deny', id: job.id, ownerId: this.ownerId,
        commandId: job.commandId, goalVersion: job.context.goalVersion, resourceId: this.ready.resourceId }) + '\n');
    } else if (value.kind === 'result') {
      if (value.commandId !== job.commandId) job.finish(failure('result_command_identity_mismatch', job.granted ? 'unknown' : 'not_started'));
      else if (value.ok !== true) job.finish(failure(value.error?.code ?? 'broker_operation_failed', value.error?.outcome));
      else if (job.kind === 'read' && (value.result?.queryId !== job.queryId || value.result?.resourceId !== this.ready?.resourceId
          || value.result?.fresh !== true || typeof value.result?.properties?.power !== 'boolean')) job.finish(failure('readback_identity_mismatch'));
      else {
        if (job.kind === 'read') this.freshRead = true;
        job.finish(null, { ...value.result, brokerClockId: value.clockId, brokerDurationMs: value.durationMs });
      }
    }
  }
  call(kind, intent, context) {
    if (intent.target !== 'lamp' || intent.property !== 'power') return Promise.reject(failure('unsupported_lamp_property'));
    if (kind === 'write' && (this.mode !== 'execute' || this.config.allowWrite !== true || !this.freshRead)) return Promise.reject(failure('actuation_disabled'));
    if (kind === 'write' && (typeof context.commandId !== 'string' || !context.commandId || !Number.isSafeInteger(context.goalVersion)
        || context.goalVersion < 1 || context.resourceId !== this.ready?.resourceId)) return Promise.reject(failure('invalid_write_identity'));
    if (!Number.isFinite(context.deadline) || !context.queryId && kind === 'read') return Promise.reject(failure('invalid_operation_context'));
    const job = { id: randomUUID(), kind, context, queryId: context.queryId, started: false, settled: false, granted: false };
    job.commandId = context.commandId ?? 'diagnostic-' + job.id;
    let resolveResult, rejectResult, release;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    job.done = new Promise(resolve => { release = resolve; });
    const abort = () => {
      if (job.settled || job.expiring) return;
      job.expiring = true;
      const finish = () => job.finish(failure('operation_deadline_or_cancelled', job.granted ? 'unknown' : 'not_started'));
      if (job.started && job.child) void this.terminate(job.child).then(finish, () => job.finish(failure('broker_not_quiescent', 'unknown')));
      else finish();
    };
    const timer = setTimeout(abort, Math.max(0, context.deadline - performance.now()));
    context.signal?.addEventListener('abort', abort, { once: true });
    job.finish = (error, value) => {
      if (job.settled) return;
      job.settled = true; clearTimeout(timer); context.signal?.removeEventListener('abort', abort);
      if (this.active === job) this.active = null;
      release(); if (error) rejectResult(error); else resolveResult(value);
    };
    if (context.signal?.aborted) abort();
    this.tail = this.tail.catch(() => {}).then(async () => {
      if (job.settled) return;
      job.started = true;
      try {
        const starting = this.start(); job.child = this.child;
        await starting;
        if (job.settled || job.expiring) return;
        if (context.resourceId && context.resourceId !== this.ready.resourceId) throw failure('resource_identity_mismatch');
        job.child = this.child; this.active = job;
        const remainingMs = Math.min(this.config.operationLimitMs, context.deadline - performance.now());
        if (remainingMs <= 0 || context.signal?.aborted) { abort(); return; }
        job.child.stdin.write(JSON.stringify({ kind, id: job.id, ownerId: this.ownerId, remainingMs,
          commandId: job.commandId, goalVersion: context.goalVersion, resourceId: this.ready.resourceId,
          queryId: job.queryId, value: intent.value }) + '\n');
        await job.done;
      } catch (error) { if (!job.expiring) job.finish(error); }
    });
    return result;
  }
  readFresh(intent, context) { return this.call('read', intent, context); }
  write(intent, context) { return this.call('write', intent, context); }
  preview(intent, context) { return this.call('preview', intent, context); }
  async terminate(child = this.child) {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timeout;
    try {
      await Promise.race([child.ownerExit, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(failure('broker_not_quiescent', 'unknown')), this.config.closeTimeoutMs);
      })]);
    } finally { clearTimeout(timeout); }
  }
  async close() {
    this.closed = true;
    await this.terminate();
    await this.tail;
  }
}

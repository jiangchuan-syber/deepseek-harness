import { randomUUID } from 'node:crypto';

const TARGETS = new Map([['台灯', 'lamp'], ['灯', 'lamp'], ['循环扇', 'fan'], ['风扇', 'fan'],
  ['净化器', 'purifier'], ['空调', 'ac']]);
const TERMINAL = new Set(['verified', 'rejected', 'superseded', 'cancelled']);

/** Recognize one complete explicit command; all other language stays with the parent. */
export function parseSimpleControl(text) {
  if (typeof text !== 'string') return null;
  const input = text.trim().replace(/[。！!]$/, '').replace(/^请/, '');
  const target = '(台灯|灯|循环扇|风扇|净化器|空调)';
  const action = '(打开|开启|关闭|关掉|开|关)';
  const prefix = input.match(new RegExp('^' + action + target + '$'));
  const suffix = input.match(new RegExp('^(?:把)?' + target + action + '$'));
  if (prefix || suffix) {
    const name = prefix ? prefix[2] : suffix[1], verb = prefix ? prefix[1] : suffix[2];
    return { target: TARGETS.get(name), property: 'power', value: ['打开', '开启', '开'].includes(verb) };
  }
  const bright = input.match(/^(?:把)?台灯亮度(?:调到|设为)([0-9]{1,3})(?:%|％)?$/);
  if (bright) return { target: 'lamp', property: 'brightness', value: Number(bright[1]) };
  const temperature = input.match(/^(?:把)?空调温度(?:调到|设为)([0-9]{1,3})度?$/);
  if (temperature) return { target: 'ac', property: 'temperature', value: Number(temperature[1]) };
  return null;
}

function validate(intent) {
  if (intent.property === 'brightness' && (intent.value < 1 || intent.value > 100)) return 'brightness_out_of_range';
  if (intent.property === 'temperature' && (intent.value < 16 || intent.value > 30)) return 'temperature_out_of_range';
  return null;
}

function mappingMatches(mapping, intent, resourceId = mapping?.resourceId) {
  return mapping?.approved === true && mapping?.unique === true && mapping?.homeSuffix === '3625'
    && typeof resourceId === 'string' && resourceId.length > 0 && mapping.resourceId === resourceId
    && Array.isArray(mapping.properties) && mapping.properties.includes(intent.property);
}

/** Fixture-first control scheduling. A provider must own authorization, identity and fresh device reads. */
export class SimpleControlLane {
  constructor({ provider, budgetMs, capacity, store, observe = () => {}, now = () => performance.now() }) {
    if (!provider || !['resolve', 'write', 'readFresh'].every(key => typeof provider[key] === 'function')) throw new Error('Control provider required');
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid control limits');
    this.provider = provider; this.budgetMs = budgetMs; this.capacity = capacity; this.store = store;
    this.observe = observe; this.now = now; this.clockId = randomUUID();
    this.entries = new Map(); this.versions = new Map(); this.tails = new Map(); this.active = new Set(); this.closed = false;
    for (const fact of store.load()) {
      if (fact.kind !== 'control.snapshot') continue;
      const entry = { ...fact.value, restored: true, promise: Promise.resolve() };
      if (!TERMINAL.has(entry.status)) { entry.status = 'unknown'; entry.needsReconcile = true; }
      this.entries.set(entry.commandId, entry);
      this.versions.set(entry.resourceId, Math.max(this.versions.get(entry.resourceId) ?? 0, entry.goalVersion));
    }
  }
  snapshot(entry) {
    if (!entry) return undefined;
    const { promise: _promise, controller: _controller, ...value } = entry;
    return { ...value, currentGoal: (this.versions.get(entry.resourceId) ?? 0) === entry.goalVersion };
  }
  get(commandId) { return this.snapshot(this.entries.get(commandId)); }
  stats() { return { activeAdmissions: this.active.size, admissionCapacity: this.capacity,
    retainedCommands: this.entries.size, snapshotLimit: this.capacity }; }
  state() {
    const active = [...this.active].map(id => this.entries.get(id));
    const recent = [...this.entries.values()].filter(entry => !this.active.has(entry.commandId));
    const remaining = Math.max(0, this.capacity - active.length);
    return [...(remaining ? recent.slice(-remaining) : []), ...active].map(entry => this.snapshot(entry));
  }
  publish(entry) {
    const value = this.snapshot(entry);
    this.store.append({ kind: 'control.snapshot', value });
    try { this.observe(value); } catch { /* Diagnostics cannot change a device fact. */ }
  }
  offer(job) {
    const intent = parseSimpleControl(job.text);
    if (!intent) return { handled: false };
    if (this.closed) throw new Error('Control lane closed');
    if (typeof job.requestId !== 'string' || !job.requestId) throw new Error('Control requestId required');
    const previous = this.entries.get(job.requestId);
    if (previous) {
      if (JSON.stringify(previous.intent) !== JSON.stringify(intent)) throw new Error('Control requestId collision');
      if (previous.needsReconcile) {
        if (this.active.size >= this.capacity) throw new Error('Control active-admission budget full');
        this.schedule(previous, true);
      }
      return { handled: true, commandId: job.requestId };
    }
    let mapping;
    try { mapping = this.provider.resolve(intent); } catch { mapping = null; }
    if (mapping?.unsupported === true) return { handled: false };
    const preparationRequired = mapping?.preparationRequired === true && typeof this.provider.prepare === 'function'
      && mapping.homeSuffix === '3625' && typeof mapping.resourceId === 'string' && mapping.resourceId.length > 0
      && Array.isArray(mapping.properties) && mapping.properties.includes(intent.property);
    const validMapping = mappingMatches(mapping, intent);
    const resourceId = validMapping || preparationRequired ? mapping.resourceId : 'unresolved:' + intent.target;
    const error = validate(intent) ?? (validMapping || preparationRequired ? null : 'unverified_device_mapping');
    if (!error && this.active.size >= this.capacity) throw new Error('Control active-admission budget full');
    const goalVersion = (this.versions.get(resourceId) ?? 0) + (error ? 0 : 1);
    if (!error) this.versions.set(resourceId, goalVersion);
    const entry = { commandId: job.requestId, voiceSessionId: job.voiceSessionId, intent, resourceId, goalVersion,
      clockId: this.clockId, acceptedAt: this.now(), status: 'queued', preparationRequired,
      writeAttempted: false, writeAcknowledged: false };
    this.entries.set(job.requestId, entry);
    if (error) { entry.status = 'rejected'; entry.error = error; this.publish(entry); entry.promise = Promise.resolve(); }
    else { this.publish(entry); this.schedule(entry, false); }
    return { handled: true, commandId: job.requestId };
  }
  schedule(entry, reconcileOnly) {
    entry.needsReconcile = false;
    this.active.add(entry.commandId);
    const tail = this.tails.get(entry.resourceId) ?? Promise.resolve();
    entry.promise = tail.catch(() => {}).then(() => this.run(entry, reconcileOnly))
      .finally(() => this.active.delete(entry.commandId));
    this.tails.set(entry.resourceId, entry.promise);
  }
  async run(entry, reconcileOnly) {
    if (entry.status === 'cancelled') return;
    if (this.versions.get(entry.resourceId) !== entry.goalVersion) {
      entry.status = 'superseded'; this.publish(entry); return;
    }
    const start = this.now(), deadline = (reconcileOnly ? start : entry.acceptedAt) + this.budgetMs;
    if (reconcileOnly) {
      entry.originalClockId = entry.clockId; entry.originalAcceptedAt = entry.acceptedAt;
      entry.clockId = this.clockId; entry.acceptedAt = start; entry.originalLatencyUnknown = true;
    }
    const controller = new AbortController(); entry.controller = controller;
    const timeout = setTimeout(() => controller.abort('deadline'), Math.max(0, deadline - this.now()));
    const context = { commandId: entry.commandId, goalVersion: entry.goalVersion, resourceId: entry.resourceId,
      signal: controller.signal, deadline, now: this.now, clockId: this.clockId,
      isCurrent: () => this.versions.get(entry.resourceId) === entry.goalVersion };
    const expired = () => controller.signal.aborted || this.now() >= deadline;
    try {
      if (expired()) { entry.status = 'cancelled'; entry.error = 'expired_before_write'; return; }
      if (!reconcileOnly) {
        if (entry.preparationRequired) {
          await this.provider.prepare(entry.intent, context);
          if (expired()) { entry.status = 'cancelled'; entry.error = 'expired_during_preflight'; return; }
          if (!context.isCurrent()) { entry.status = 'superseded'; return; }
          if (!mappingMatches(this.provider.resolve(entry.intent), entry.intent, entry.resourceId)) {
            entry.status = 'rejected'; entry.error = 'unverified_device_mapping'; return;
          }
          entry.preparationRequired = false;
        }
        entry.status = 'writing'; entry.writeAttempted = true; this.publish(entry);
        try { await this.provider.write(entry.intent, context); entry.writeAcknowledged = true; }
        catch (error) {
          if (error?.outcome === 'not_started') {
            entry.writeAttempted = false; entry.status = 'rejected'; entry.error = error.code ?? 'write_not_started'; return;
          }
          entry.error = 'write_outcome_unknown';
        }
      }
      if (expired()) { entry.status = 'unknown'; entry.error = 'deadline_after_possible_write'; return; }
      entry.status = 'reading'; entry.readIssuedAt = this.now(); this.publish(entry);
      const queryId = randomUUID();
      const readback = await this.provider.readFresh(entry.intent, { ...context, queryId });
      const value = readback?.properties?.[entry.intent.property];
      entry.readback = { resourceId: readback?.resourceId === entry.resourceId ? entry.resourceId : null,
        fresh: readback?.fresh === true, queryId: readback?.queryId === queryId ? queryId : null,
        properties: { [entry.intent.property]: typeof value === typeof entry.intent.value ? value : null } };
      if (expired()) { entry.status = 'unknown'; entry.error = 'deadline_during_readback'; return; }
      const confirmed = readback?.resourceId === entry.resourceId && readback?.fresh === true
        && readback.queryId === queryId
        && readback.properties?.[entry.intent.property] === entry.intent.value;
      entry.status = confirmed ? 'verified' : 'unknown';
      if (!confirmed) entry.error = 'readback_not_confirmed';
      else delete entry.error;
    } catch { entry.status = entry.writeAttempted || reconcileOnly ? 'unknown' : 'rejected'; entry.error = 'control_operation_failed'; }
    finally {
      clearTimeout(timeout); entry.settledAt = this.now();
      entry.elapsedMs = reconcileOnly ? null : entry.settledAt - entry.acceptedAt;
      if (reconcileOnly) entry.recoveryElapsedMs = entry.settledAt - start;
      delete entry.controller; this.publish(entry);
    }
  }
  async settled(commandId) { const entry = this.entries.get(commandId); if (entry) await entry.promise; return this.get(commandId); }
  cancel(commandId) {
    const entry = this.entries.get(commandId);
    if (!entry || TERMINAL.has(entry.status)) return;
    if (entry.status === 'queued') { entry.status = 'cancelled'; this.publish(entry); }
    else entry.controller?.abort('explicit_command_cancel');
  }
  async close() {
    this.closed = true;
    const owned = [...this.active].map(id => this.entries.get(id));
    for (const entry of owned) this.cancel(entry.commandId);
    await Promise.allSettled(owned.map(entry => entry.promise));
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const STATES = new Set(['queued', 'writing', 'reading', 'verified', 'rejected', 'unknown', 'superseded', 'cancelled']);
const identity = value => typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;

/** Bounded business facts for the local bridge; no native tool-call or private provider data. */
export function controlView(raw) {
  if (!raw || !identity(raw.commandId) || !identity(raw.resourceId) || !identity(raw.clockId)
      || !Number.isSafeInteger(raw.goalVersion) || raw.goalVersion < 0 || !STATES.has(raw.status)
      || !['lamp', 'ac', 'fan', 'purifier'].includes(raw.intent?.target)
      || !['power', 'brightness', 'temperature'].includes(raw.intent?.property)
      || !(typeof raw.intent.value === 'boolean' || Number.isFinite(raw.intent.value))) return undefined;
  const view = { commandId: raw.commandId, requestId: raw.commandId, voiceSessionId: identity(raw.voiceSessionId),
    origin: 'program-control', resourceId: raw.resourceId, clockId: raw.clockId, goalVersion: raw.goalVersion,
    status: raw.status, intent: { target: raw.intent.target, property: raw.intent.property, value: raw.intent.value },
    currentGoal: raw.currentGoal === true, writeAttempted: raw.writeAttempted === true,
    writeAcknowledged: raw.writeAcknowledged === true, physicalEffectVerified: false };
  for (const key of ['acceptedAt', 'readIssuedAt', 'settledAt', 'elapsedMs', 'recoveryElapsedMs']) {
    if (raw[key] === null || Number.isFinite(raw[key]) && raw[key] >= 0) view[key] = raw[key];
  }
  if (identity(raw.error)) view.error = raw.error;
  if (raw.readback && typeof raw.readback === 'object') {
    const value = raw.readback.properties?.[raw.intent.property];
    if (typeof value === 'boolean' || Number.isFinite(value)) view.readback = {
      resourceId: identity(raw.readback.resourceId), queryId: identity(raw.readback.queryId),
      fresh: raw.readback.fresh === true, properties: { [raw.intent.property]: value },
    };
  }
  return view;
}

export function controlSnapshot(state) {
  const controls = (Array.isArray(state.controls) ? state.controls.slice(-256) : []).map(controlView).filter(Boolean);
  return { controls,
    controlProjection: { schemaVersion: 1, sourceInstance: identity(state.controlSourceInstance),
      sequence: Number.isSafeInteger(state.controlSequence) && state.controlSequence >= 0 ? state.controlSequence : 0,
      ...(Number.isSafeInteger(state.controlStats?.retainedCommands) ? {
        retainedCommands: state.controlStats.retainedCommands,
        historyTruncated: state.controlStats.retainedCommands > controls.length,
      } : {}) } };
}

/** Only an exact single command ID is accepted; inspection never admits a job. */
export function controlQuery(parameters) {
  if ([...parameters.keys()].length !== 1 || parameters.getAll('commandId').length !== 1
      || !identity(parameters.get('commandId'))) throw new Error('Exactly one valid commandId is required');
  return parameters.get('commandId');
}

export function controlResult(lane, commandId, sequence) {
  const fact = controlView(lane?.get(commandId));
  return { kind: 'control.result', requestedCommandId: commandId, found: !!fact, control: fact ?? null,
    sourceInstance: lane?.clockId, sequence };
}

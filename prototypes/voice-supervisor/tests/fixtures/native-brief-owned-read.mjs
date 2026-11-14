/** Observe direct outcome and the real provider-managed range independently. */
export async function observeOwnedRead(handle, entry, failure, changed) {
  const direct = handle.done.then(outcome => { entry.exitCode = outcome.exitCode; }, error => failure('direct', error));
  const empty = handle.waitForExit().then(value => { entry.rangeEmpty = value; }, error => failure('range', error));
  await Promise.all([direct, empty]);
  entry.settled = true;
  changed();
}

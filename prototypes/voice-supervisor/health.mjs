/** Local process health; dependency readiness never triggers immediate restart. */
export function runtimeHealth({ exited, stopping, lastPollAt, now = performance.now() }) {
  const pollAgeMs = lastPollAt ? Math.max(0, now - lastPollAt) : null;
  const live = !exited && !stopping && (pollAgeMs === null || pollAgeMs < 60000);
  return { live, ready: live && pollAgeMs !== null && pollAgeMs < 10000, pollAgeMs };
}

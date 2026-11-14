---
kind: upgrade-guide
description: The voice prototype control snapshot becomes bounded while capacity limits active admissions instead of retained history.
---

# Read retained voice control results explicitly

English | [中文](guide.zh.md)

## Change

The voice prototype's `simpleControl.capacity` limits queued, preparing, executing and reconciling promises. Completed records remain available for deduplication without consuming an active slot. `/state.controls` no longer includes all retained history; snapshots contain active entries and recent records up to the capacity, with the outer projection capped at 256. This is an application protocol, not a native model tool-call format.

## Migration

1. Keep the private control journal and old command IDs. Do not delete terminal history or raise capacity to hide replay/state lookup problems; retained memory and journal storage are not bounded by the active budget.
2. Update consumers to use authenticated `GET /control-result?commandId=<exact-id>` when a bounded snapshot no longer contains a known command. Preserve the original request, voice session, goal version and clock; verify the current projection source. This GET never starts a broker or performs device I/O.
3. Keep the provider disabled until the matching producer and bridge consumer are deployed and verified together. Confirm sequential tasks beyond the active capacity, old-ID replay and restart recovery with offline fixtures before any separately announced device window.

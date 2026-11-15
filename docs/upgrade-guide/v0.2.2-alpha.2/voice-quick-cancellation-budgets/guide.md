---
kind: upgrade-guide
description: Custom voice-supervisor overlays must declare acknowledgement cancellation budgets.
---

# Voice acknowledgement cancellation budgets

English | [中文](guide.zh.md)

## Change

Custom configurations for the optional voice-supervisor prototype now require `quick.cancelGraceMs` and `quick.maxOutstanding`. A newer input cancels older quick acknowledgements in the same native parent Session while preserving their original goals for deep processing. An unresolved provider cleanup can occupy a bounded slot instead of holding every later acknowledgement. Parent and child execution remain separate.

`/quick-probe` now requires an idle lane and returns HTTP 409 while a quick call or another diagnostic is outstanding. Real input cancels a diagnostic; its pending cleanup still occupies a slot.

## Migration

1. If using the repository's `prototypes/voice-supervisor/overlay.yml`, retain its new keys. For a custom overlay, add `cancelGraceMs: 50` and `maxOutstanding: 2` under the existing plugin's `quick` object.
2. Keep `cancelGraceMs` a positive integer no greater than `timeoutMs`; set `maxOutstanding` to `1` or `2`. The budget counts active and unresolved provider calls together. A full budget produces a visible quick failure with an empty acknowledgement while the original input continues to the native parent.
3. Run the prototype's documented checks in its [README](../../../../prototypes/voice-supervisor/README.md). Inspect `/state` for `quickCleanupPending` and `quickOutstanding`; queued obsolete acknowledgements must not publish late text or completion, and shutdown must not report provider cleanup complete before it settles.

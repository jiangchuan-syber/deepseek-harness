# Voice supervisor laboratory

English | [中文](README.zh.md)

This opt-in prototype lets one persistent Harness parent acknowledge input with thinking off, continue with high reasoning effort, delegate native child work, and return results through an interruptible speech queue. It does not replace the installed desktop application.

## Documents

- [Product requirements](docs/PRD.zh.md)
- [Development and acceptance plan](docs/PLAN.zh.md)
- [Runtime review](docs/2026-10-31-runtime-review.zh.md)

## Run

Requires Node >=24.9, the repository's pinned pnpm, and `DEEPSEEK_API_KEY` in the launch environment. `VOICE_MODEL` defaults to `deepseek-flash`. The interactive runner uses the same native parent with effort `off` for acknowledgements and `high` for execution decisions; native children use the provider defaults.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build:artifacts
node --test prototypes/voice-supervisor/tests/*.test.mjs
pnpm exec oxlint -c prototypes/voice-supervisor/oxlint.json --disable-nested-config prototypes/voice-supervisor
node prototypes/voice-supervisor/interactive.mjs
```

The runner creates an isolated home and fixture workspace under `.runs/`, launches the supported `dsh --profile web` source entry with the overlay, and prints an authenticated loopback page URL. It keeps credentials in the process environment. The fixture worker waits 22 seconds, hashes `sample.txt`, and writes `worker-result.json`; this wait creates an interaction window, not a performance measurement.

## Manual test page

Keep the printed page open. Submit the sample task, interrupt virtual playback, and send a follow-up while the parent is thinking or a child is running. Acknowledgements and decision requests belong to the same durable native session. The page accepts text as simulated ASR input; playback uses a virtual character clock and produces no sound.

The ESP32 bridge separately supplies real ASR, TTS, PCM transport, and whole-chunk device receipts. Its four-module workbench displays the quick stage, deep processing, queued input, native tool traffic, child settlement, and actual playback evidence. Speech and model work can progress concurrently.

The interface binds to `127.0.0.1` and authenticates API requests with a local token. Ctrl+C stops the runner. `VOICE_LAB_RESUME_DIR` with the corresponding `VOICE_LAB_SESSION_ID` resumes a retained isolated home and parent; fixture files are not overwritten. Normal startup creates a fresh isolated session. Do not use this development runner for untrusted tasks.

## Integration behavior

Input admission returns HTTP 202 and a request ID. The phase queue serializes the native parent, prioritizes queued user acknowledgements, and merges pending deep continuations against the latest conversation. User text enters the native session once; an internal application continuation message continues processing without repeating that user request. The quick stage restricts tools and denies execution; decision requests restore tools and start a new request series so the upstream declaration list has a nondeferred baseline.

The parent switches between `off` and `high` before native requests. Model events expose request timing and the category of the first reasoning, text, or tool delta; private reasoning text is not forwarded. Both explicit agent messages and automatic settlement notices establish child-result receipt. Child output is summarized by the parent before speech.

Phase events and admissions are appended to a local queue journal. Generated speech is appended to an outbox. Pending native messages are supplied as unconfirmed delivery context on later inputs. Only all real-device pieces acknowledged as completed settle a native message; virtual playback does not confirm real-device delivery. Unfinished requests are not automatically replayed after restart.

For real staged acceptance, run `node --import tsx/esm prototypes/voice-supervisor/verify-staged.mjs PRIVATE_CONFIG_PATH` against a fresh isolated runner using its local client-config file. The check refuses an existing conversation, submits two synthetic inputs, verifies native off/high headers and actual reasoning, and independently checks the worker artifact. It leaves the dedicated runner open for inspection.

## Limitations

The parent does not answer immediately during an already-running deep request; new input is visibly queued. Long execution should use children. Speech is released on completed native messages; subsequent deep responses do not stream sentence by sentence while tool arguments are still being generated. The old `run-live.mjs` exercises the earlier independent-front scenario and is not the staged runner's acceptance command.

Queue journals retain evidence but do not provide crash-safe task replay or autonomous delivery after an empty recording. Undelivered older output is supplied for the parent's review rather than replayed automatically. The firmware has no interrupted-chunk sample cursor. Prompt directory constraints are not an operating-system sandbox; context capacity and compaction remain native Harness behavior.

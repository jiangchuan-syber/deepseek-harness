# Voice supervisor laboratory

English | [中文](README.zh.md)

This opt-in prototype acknowledges input through an independent bounded request with thinking off, while a persistent Harness parent uses max reasoning effort to delegate native child work and return results through an interruptible speech queue. It does not replace the installed desktop application.

## Documents

The local runtime exposes authenticated `/health/live` and `/health/ready` endpoints. Readiness requires recent native polling; a dead child or prolonged polling failure makes liveness fail. SSE publishes an immediate connection comment and closes when the native process exits. Diagnostic output rotates independently of durable Session logs. Windows deployment and owned-process recovery are managed by the enclosing project's `server/service_manager.py`, not by this optional prototype.

- [Product requirements](docs/PRD.zh.md)
- [Development and acceptance plan](docs/PLAN.zh.md)
- [Runtime review](docs/2026-10-31-runtime-review.zh.md)

## Run

Requires Node >=24.9, the repository's pinned pnpm, and `DEEPSEEK_API_KEY` in the launch environment. `VOICE_MODEL` defaults to `deepseek-flash`. The interactive runner uses an independent tool-free `off` request for acknowledgements and the persistent native parent with `max` for execution decisions; native children inherit compatible parent model and effort settings unless overridden.

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

Keep the printed page open. Submit the sample task, interrupt virtual playback, and send a follow-up while the parent is thinking or a child is running. Acknowledgements use a bounded request journal; execution decisions belong to the persistent native session. The page accepts text as simulated ASR input; playback uses a virtual character clock and produces no sound.

The ESP32 bridge separately supplies real ASR, TTS, PCM transport, and whole-chunk device receipts. Its four-module workbench displays the quick stage, deep processing, queued input, native tool traffic, child settlement, and actual playback evidence. Speech and model work can progress concurrently.

The interface binds to `127.0.0.1` and authenticates API requests with a local token. Ctrl+C stops the runner. `VOICE_LAB_RESUME_DIR` with the corresponding `VOICE_LAB_SESSION_ID` resumes a retained isolated home and parent; fixture files are not overwritten. Normal startup creates a fresh isolated session. Do not use this development runner for untrusted tasks.

## Integration behavior

Input admission returns HTTP 202 and a request ID. The quick lane runs independently of native deep work. Each quick request uses its own short system, at most 1200 recent conversation characters and 600 latest-input characters, effort `off`, no tool declarations or executor, and 64 output tokens. It stops at one sentence or 30 Unicode characters. These limits are configurable in `overlay.yml`. The runner forwards the quick speech events before acknowledging `/continue`; only then does the native phase queue receive the original untruncated input, acknowledgement and playback receipt. It may merge pending continuations. Failed admission is visible and does not report execution as started.

Quick speech uses a natural response rather than a mandatory opening. A stop before usable text is a visible quick failure with an empty continuation acknowledgement; it does not fabricate speech. The bridge's fixed wake cue remains a separate device event. Natural quick text stays in recent context and the deep continuation; this does not establish that it was played.

The native parent uses the overlay's `supervisorReasoningEffort: max` on startup and between execution stages; quick calls do not change its model selection. Model events expose request timing and first-delta categories. The authenticated `/speech-events` SSE additionally forwards visible parent text deltas, generation IDs and message settlements; private reasoning and tool arguments are not forwarded. Both explicit agent messages and automatic settlement notices establish child-result receipt. Child output is summarized by the parent before speech.

Continuation instructions reserve direct execution for very simple operations and state checks, and delegate reasoning or multi-step work. The parent checks a child brief against the current goal, evidence and side effects, then reports relevant results, uncertainties and decisions without reading the brief verbatim. Missing evidence is not verified success; interrupting speech does not cancel the child. These are model instructions, not additional execution isolation or expanded tool permissions.

Quick request inputs and responses are recorded in the private `quick-requests.jsonl`; they do not enter the main request history until the deep continuation. Phase events and admissions are appended to a local queue journal. Generated speech is appended to an outbox. Pending native messages are supplied as unconfirmed delivery context on later inputs. Only all real-device pieces acknowledged as completed settle a native message; virtual playback does not confirm real-device delivery. Unfinished requests are not automatically replayed after restart.

The authenticated POST `/quick-probe` measures the same quick call with a fixed synthetic 1200-character history; it does not speak, dispatch work, or update conversational memory. Its TTFT uses a monotonic clock around the application model stream, not a provider-only inference timer. `verify-staged.mjs` requires a fresh isolated runner and checks quick request journals, native deep headers, child completion and the independently verified worker artifact. It must not run against a retained user session.

## Limitations

Quick replies can run during deep work; new deep decisions still wait for the serialized native parent. Long execution should use children. The v2 Python bridge commits visible text incrementally to one Qwen PCM task per utterance. It requires matching v2 device firmware; the legacy device path still consumes completed messages. Only device consumption confirmation settles delivery. The old `run-live.mjs` exercises the earlier independent-front scenario and is not the staged runner's acceptance command.

Queue journals retain evidence but do not provide crash-safe task replay or autonomous delivery after an empty recording. Undelivered older output is supplied for the parent's review rather than replayed automatically. Firmware v2 reports conservative consumed-sample cursors; word alignment is unavailable. Prompt directory constraints are not an operating-system sandbox; context capacity and compaction remain native Harness behavior.

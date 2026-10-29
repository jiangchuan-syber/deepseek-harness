# Voice supervisor laboratory

English | [中文](README.zh.md)

This opt-in prototype exercises a fast acknowledgement model, a persistent Harness parent, native child execution, and a single interruptible virtual audio queue. It is not enabled in shipped profiles and does not replace the installed desktop application.

## Documents

- [Product requirements](docs/PRD.zh.md)
- [Development and acceptance plan](docs/PLAN.zh.md)
- [Validation report and measured evidence](docs/VALIDATION.zh.md)

## Run

Requires Node >=24.9, the repository's pinned pnpm, and a DeepSeek API key supplied through `DEEPSEEK_API_KEY`. The key is inherited only by the test process; do not put it in a tracked file. `VOICE_MODEL` selects the fast model and defaults to `deepseek-flash`; thinking is disabled. Parameter count is not inferred from the model name.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build:artifacts
node --test prototypes/voice-supervisor/tests/*.test.mjs
pnpm exec oxlint -c prototypes/voice-supervisor/oxlint.json --disable-nested-config prototypes/voice-supervisor
node prototypes/voice-supervisor/run-live.mjs
```

The live command creates a private test home and workspace under `.runs/`, launches the supported `dsh --profile web` source entry with [the overlay](overlay.yml), and drives the authenticated loopback [plugin](plugin.mjs). It does not use the user's normal Harness home. The runner grants the isolated test session full execution permission so its native child can run a known local checksum fixture; use only a trusted development machine. It submits only synthetic task text. API calls incur normal model usage.

A successful run writes `result.json`, `events.jsonl`, `playback.jsonl`, `process.json`, and `harness.log`. Model failures cause a failing exit code; no recorded model response is used as a substitute. ASR, TTS, and playback timing are explicitly virtual. The worker's 22-second wait is a test window for parent interaction, not a performance measurement.

## Integration behavior

Prompt admission returns HTTP 202 without waiting for whole-agent idle. Native session events are polled with an ordered cursor; an expired cursor returns 410 instead of silently losing events. Outputs belong to a main-session stream, not exclusively to the most recently accepted user message. Client code must retain the native sequence and turn identifiers when mapping overlapping work.

The [playback queue](playback.mjs) lets an already-started acknowledgement finish before ordinary parent speech. A button interruption increments the playback epoch, drops queued older speech, and records played and unplayed text separately. The next prompt carries that receipt as logged application context; original Harness assistant history is preserved. Virtual character timing is not a claim of real-device word alignment or human comprehension.

## Limitations

This is a command-driven lab, not a production ESP32 service. Front responses are generated independently; primary answers and native subagents run inside Harness. Real TTS streaming, firmware sample receipts, cross-device clock errors, task resumption after host failure, and persistent playback storage are outside this prototype. The parent context uses native model capacity and native compaction rather than an invented unlimited context. Speech does not automatically cancel worker execution.

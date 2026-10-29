# Agent Note: Voice supervisor laboratory

Status: proposed

English | [中文](2026-10-30-voice-supervisor-lab.zh.md)

## Problem

A voice client that rejects input while one prompt waits for whole-agent idle cannot support a parent conversation during native child work. A client that copies arbitrary provider text into speech also cannot distinguish acknowledgements, primary answers, and unplayed output after interruption.

## Proposal

Keep the native Agent loop and delegation runtime. Mount an opt-in laboratory plugin through a dsh profile, return prompt admission independently of result collection, and observe native main-session and child events. Keep acknowledgement generation and audio delivery in the external laboratory client. Record virtual delivery receipts as logged prompt context without rewriting the original assistant log.

The [laboratory plan](../../../../prototypes/voice-supervisor/docs/PLAN.zh.md) owns the experiment and its acceptance matrix. It separates real API measurements from simulated recognition and playback. No production profile imports the prototype.

## Alternatives considered

**Patch the Agent loop.** Native inbox and background delegation already exist; changing their lifecycle adds risk before the client integration has been exercised.

**Copy the entire provider response stream to speech.** This conflates background and main output and does not establish what was played. The client instead selects main-session answers and tracks audio delivery independently.

**Pretend acceptance means completion.** Admission can happen while a child still runs. The experiment requires a main answer before native child completion, plus an independently checked worker artifact.

## Acceptance criteria

A real DeepSeek run demonstrates main-session response during native child execution, a checked checksum artifact, acknowledgement-before-answer ordering, and a partial-playback receipt in the next main prompt. Offline tests reject stale playback and propagate model failures. The report identifies simulation and capability limits.

## Risks

Model-selected tool behavior can vary. The controlled worker wait only supplies an overlap window; it does not establish model performance. Virtual character alignment is not a substitute for device sample receipts. The isolated test grants full permission to a synthetic fixture session and must not receive untrusted task text.

# Lamp control provider reference

English | [中文](MIIO-PROVIDER.zh.md)

The optional `MiioLampProvider` is disabled by default and is not registered with the live Harness. It supplies a private stdio Python executor for one approved lamp, plus offline actuator fixtures and an explicit read-only smoke. Normal `server/xiaomi_ctl.py` writes have not been redirected through this owner; production execute mode must remain disabled until that cooperative integration is in place. This is not an arbitrary-shell sandbox.

## Configuration

| Field | Meaning |
| --- | --- |
| `enabled` | Only literal true permits starting a broker; default false. |
| `python`, `workspace` | Explicit interpreter with installed python-miio, and the approved workspace containing private inventory. |
| `expectedLampHash` | First 16 lowercase SHA256 hex digits of the approved inventory DID; mandatory, never selected by fuzzy model matching. |
| `operationLimitMs` | Maximum budget for one broker request; the Node caller also supplies an absolute local deadline. |
| `startupTimeoutMs`, `closeTimeoutMs` | Explicit startup and owned-process quiescence budgets. |
| `mode` | `read-only` by default; `dry-run` only previews; `execute` additionally requires `allowWrite` and `cooperativeControlReady` true. |
| `fixture` | Explicit file-backed offline physical-device fixture; never imports miio or opens a network socket. |

The broker loads exactly one home ending in 3625 and exactly one `yeelink.light.lamp27`, pins its expected DID hash, and verifies the actual handshake device identity before network operations. It never projects IP addresses or credentials. An OS mutex for the actual home identity permits one Python execution owner across processes; a second owner fails closed. The Node control lane remains the only durable command ledger.

## Execution and timing

Only lamp power is supported. Read-only and dry-run providers cannot approve actuator jobs. Execute mode first requires a fresh read in the current owner lifetime. A write-ready/authorize exchange rechecks the current goal and cancellation before sending; an already granted write can have side effects even if the user changes goals afterward. Same-command replay remains the control ledger's responsibility.

The reviewed python-miio version is pinned to 0.5.12; another version fails closed. The SDK retains message framing and authentication. In this private process its discovery timeout and protocol send timeout use the current remaining budget, and automatic network retries are disabled. The Node caller enforces its own absolute deadline including queueing and startup, terminates only its owned broker on an active timeout/cancel, and awaits process exit. A queued expiry cannot terminate another active operation. An uncertain write is never automatically resent; after owner loss a new read can establish current state but cannot recover the original action latency.

Node and Python durations have separate clock identities. Python uses `perf_counter_ns`; its numbers are not subtracted from Node timestamps. A matching fresh query and protocol power property do not prove physical light output or the full physical-PTT-to-actuation three-second target. The read-only smoke records metadata and durations, omits the power value, and keeps goal acceptance `NOT_RUN`.

## Local checks

`node --import tsx/esm --test prototypes/voice-supervisor/tests/miio-provider.test.mjs` runs file-backed fixtures, including cross-process owner contention, denied stale grants, queued deadlines and a write killed after a simulated side effect followed by read-only ledger recovery. It does not operate a real lamp.

`miio-readonly-smoke.mjs` requires explicit `--python`, `--workspace`, `--expected-lamp-hash`, `--output`, `--budget-ms`, `--startup-timeout-ms` and `--close-timeout-ms`. Its mode is fixed to read-only; it cannot select a setter, change production configuration or run TTS. Save actual reports outside Git. No real write test belongs in its invocation.

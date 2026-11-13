# 台灯控制 Provider 参考

[English](MIIO-PROVIDER.md) | 中文

可选 `MiioLampProvider` 缺省关闭，尚未注册到正在运行的 Harness。它为一台已批准台灯提供私有 stdio Python 执行器、离线动作夹具和显式只读 smoke。普通 `server/xiaomi_ctl.py` 写调用尚未转交此 owner；完成协作接线前，生产 execute 模式必须保持关闭。这不是任意 shell 的安全沙箱。

## 配置

| 字段 | 含义 |
| --- | --- |
| `enabled` | 仅字面 true 允许启动 broker，缺省 false。 |
| `python`, `workspace` | 显式指定已装 python-miio 的解释器，以及包含私有设备清单的批准工作区。 |
| `expectedLampHash` | 已批准清单 DID 的 SHA256 前16位小写十六进制；必填，不按型号模糊取设备。 |
| `operationLimitMs` | 单个 broker 请求预算上限；Node 调用方另提供本地绝对截止时间。 |
| `startupTimeoutMs`, `closeTimeoutMs` | 显式启动和所属进程静止等待预算。 |
| `mode` | 缺省 `read-only`；`dry-run` 仅预览；`execute` 还需 `allowWrite` 和 `cooperativeControlReady` 均为 true。 |
| `fixture` | 显式基于文件的离线设备夹具，不导入 miio、不打开网络 socket。 |

Broker 要求尾号3625的家恰好一个、`yeelink.light.lamp27` 恰好一台，核对预期 DID 哈希，并在网络操作前检查实际握手设备身份。不投影 IP 或凭据。按真实家庭身份创建的 OS 互斥锁保证跨进程只有一个 Python 执行 owner，第二个 owner 失败关闭。Node 控制通道仍是唯一持久命令 ledger。

## 执行与计时

仅支持台灯电源。Read-only 和 dry-run provider 不能批准动作任务。Execute 模式先要求本次 owner 生命周期中的新读回。写前 ready/authorize 交接再次核对当前目标与取消；授权发出后，即使用户变更目标，已在途动作仍可能产生副作用。同一命令不重放由控制 ledger 负责。

已审阅的 python-miio 版本固定为0.5.12，其他版本失败关闭。保留 SDK 的组包与认证；只在此私有进程中，让 discovery 和协议 send 使用剩余预算，并禁用自动网络重试。Node 的本地绝对截止时间覆盖排队与启动；活动请求超时或取消时只结束所属 broker，等待退出。排队请求过期不能结束另一条正在执行的操作。未知写不自动重发；owner 丢失后，新读回可核实当前状态，但不能恢复原动作的未知时延。

Node 与 Python 持续时间各有时钟身份；Python 使用 `perf_counter_ns`，不与 Node 时间戳直接相减。新查询身份与电源协议值匹配，不证明实际发光，也不证明物理松键到家电有效操作的完整三秒目标。只读 smoke 记录元数据与耗时，省略电源值，目标验收始终为 `NOT_RUN`。

## 本地检查

`node --import tsx/esm --test prototypes/voice-supervisor/tests/miio-provider.test.mjs` 使用文件设备夹具，覆盖跨进程 owner 竞争、拒绝过时授权、排队截止时间，以及模拟副作用后杀掉执行器再只读恢复 ledger，不操作真实台灯。

`miio-readonly-smoke.mjs` 必须显式给出 `--python`、`--workspace`、`--expected-lamp-hash`、`--output`、`--budget-ms`、`--startup-timeout-ms` 和 `--close-timeout-ms`。模式固定只读，不能选择 setter、改变生产配置或调用 TTS。实际报告保留在 Git 之外；不得用它执行真实写测试。

## 共享 CLI 守卫依赖

真实传输现在要求 workspace `server/miio_control_guard.py` 协议 1，并报告 `sharedGuardProtocol=1`。实际 home+DID 的内核锁与协作版小米 CLI 共用，broker 继续保留家庭唯一 owner。模块缺失或版本不符会在网络请求前拒绝；应先部署核对匹配的 CLI/模块。本次不启用生产执行。Node 仍是唯一命令台账；独立 CLI 调用不等于跨任务 exactly-once，也不是任意 shell 权限沙箱。

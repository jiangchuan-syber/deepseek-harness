# 语音调度器实验室

[English](README.md) | 中文

本可选原型让同一个持续 Harness 主会话先关闭思考接话，再以 high 思考强度决策、按需委派原生子任务，并通过可打断语音队列返回结果。它不替换已安装的桌面应用。

## 文档

- [产品需求](docs/PRD.zh.md)
- [开发与验收计划](docs/PLAN.zh.md)
- [运行评审](docs/2026-10-31-runtime-review.zh.md)

## 运行

需要 Node >=24.9、仓库固定的 pnpm，以及启动环境中的 `DEEPSEEK_API_KEY`。`VOICE_MODEL` 默认使用 `deepseek-flash`。交互运行器使用同一原生主会话，以 `off` 接话、以 `high` 做执行决策；原生子代理使用提供方默认配置。

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run build:artifacts
node --test prototypes/voice-supervisor/tests/*.test.mjs
pnpm exec oxlint -c prototypes/voice-supervisor/oxlint.json --disable-nested-config prototypes/voice-supervisor
node prototypes/voice-supervisor/interactive.mjs
```

运行器在 `.runs/` 中创建隔离 home 与样例工作目录，使用 overlay 启动受支持的 `dsh --profile web` 源码入口，并打印带本地鉴权的回环页面 URL。凭据保留在进程环境中。样例 worker 等待 22 秒，计算 `sample.txt` 的哈希并写入 `worker-result.json`；等待用于创造交互窗口，不作为性能测量。

## 手动测试页面

保持打印出的页面打开。提交样例任务，打断虚拟播放，并在主调度思考或子任务运行时补充话语。快速回应和决策请求属于同一持久原生会话。页面接受文字模拟 ASR 输入；播放采用虚拟字符时钟，不发出声音。

ESP32 桥另行提供真实 ASR、TTS、PCM 传输和整段设备回执。四模块工作台显示快速阶段、深度处理、输入排队、原生工具流、子任务结束通知及实际播放证据。声音播放与模型工作可以并行。

接口绑定 `127.0.0.1`，通过本地 token 鉴权。Ctrl+C 停止运行器。`VOICE_LAB_RESUME_DIR` 配合对应 `VOICE_LAB_SESSION_ID` 可恢复保留的隔离 home 与主会话；不覆盖样例文件。正常启动创建新的隔离会话。不要用本开发运行器处理不可信任务。

## 集成行为

输入接纳返回 HTTP 202 和请求 ID。阶段队列串行驱动原生主会话，优先处理排队用户的接话，并结合最新对话合并待执行的深度续接。用户原话只进入原生会话一次；内部应用续接消息续接处理，不重复用户请求。快速阶段限制工具并拒绝执行；决策请求恢复工具并启动新的请求序列，让上游工具声明保留非延迟基线。

主调度在原生请求前切换 `off` 与 `high`。模型事件只提供请求计时及首个思考、文字或工具增量的类别，不转发内部思考正文。主动代理消息和自动结束通知都可确认子结果接收。子输出先由主调度整理，再交给语音。

阶段事件和接纳记录追加到本地队列日志，生成的语音追加到待播记录。后续输入将待确认的原生消息作为未确认送达上下文。只有真实设备对某条原生消息的全部片段确认完成，才确认该消息送达；虚拟播放不确认真实设备送达。重启不自动重放未完成请求。

真实分阶段验收可执行 `node --import tsx/esm prototypes/voice-supervisor/verify-staged.mjs PRIVATE_CONFIG_PATH`，参数指向新建隔离运行器的本地客户端配置文件。检查拒绝已有对话，提交两条合成输入，验证原生 off/high 请求和真实思考，并独立检查 worker 产物。专用运行器保留供检查。

## 限制

主调度在已经运行的深度请求中不能立刻回答，新输入会明确显示排队。长时间执行应使用子代理。语音依据完整原生消息释放，后续深度回答尚不支持在工具参数生成期间逐句流式播出。旧 `run-live.mjs` 验证早期独立前台场景，不是分阶段运行器的验收命令。

队列日志保留证据，但不提供崩溃后安全任务重放，也不支持空录音后自主送达。旧的未送达输出交由主调度重新判断，不自动重播。固件没有打断段采样游标。提示词中的目录约束不是操作系统沙箱；上下文容量与压缩继续使用 Harness 原生行为。

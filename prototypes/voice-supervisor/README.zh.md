# 语音主调度实验室

[English](README.md) | 中文

此可选原型验证快速接话模型、持久主会话、Harness 原生子任务执行，以及可打断的唯一虚拟音频队列。它不在默认配置中启用，也不替换已安装的桌面应用。

## 文档

- [产品需求](docs/PRD.zh.md)
- [开发与验收计划](docs/PLAN.zh.md)
- [验证报告与实测证据](docs/VALIDATION.zh.md)

## 运行

需要 Node >=24.9、仓库固定版本的 pnpm，以及通过 `DEEPSEEK_API_KEY` 提供的 DeepSeek 密钥。密钥只由测试进程继承，不要放入被跟踪的文件。`VOICE_MODEL` 选择快速模型，默认为 `deepseek-flash`，关闭思考；不通过模型名称推断参数规模。

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run build:artifacts
node --test prototypes/voice-supervisor/tests/*.test.mjs
pnpm exec oxlint -c prototypes/voice-supervisor/oxlint.json --disable-nested-config prototypes/voice-supervisor
node prototypes/voice-supervisor/run-live.mjs
```

真实运行命令在 `.runs/` 下创建隔离测试 home 和工作目录，通过[配置覆盖](overlay.yml)启动受支持的 `dsh --profile web` 源码入口，驱动需认证的本机[插件](plugin.mjs)。它不使用用户常用的 Harness home。运行器给隔离测试会话完整执行权限，以便原生子任务执行已知的本地校验脚本；仅在可信开发机器使用。只提交合成任务文本。API 调用按正常模型用量计费。

成功运行写入 `result.json`、`events.jsonl`、`playback.jsonl`、`process.json` 和 `harness.log`。模型失败返回非零退出码，不以录制回复替代真实模型。ASR、TTS 和播放时间明确为虚拟实现。工作脚本的 22 秒等待用于构造主子任务重叠窗口，不代表性能测量。

## 手动测试页面

完成上述准备后，执行 `node prototypes/voice-supervisor/interactive.mjs`，打开终端输出的本机网址，并保持进程运行。页面接受文字作为模拟 ASR 输入，以每秒九字显示虚拟播放，使用真实 DeepSeek 调用和 Harness 原生子任务。页面不发声，也不请求麦克风权限。

点击“后台校验样例”，用红色按钮或 Escape 打断播放，再点击“询问进度”。绿色表示模拟已播前缀，灰色表示未播内容。发送新消息也会打断旧音频，并附带播放回执。停止播放后，后台任务继续运行；每个活动子任务有独立的停止请求按钮。发出停止请求不代表任务已经结束。页面显示子任务生命周期与接话模型耗时。任务提示要求委派并限制在样例目录工作，但这些是模型指令，不是操作系统沙箱。

页面仅绑定 `127.0.0.1`，模型 API 密钥保留在服务端，本机接口使用独立令牌。运行时创建全新测试 home；按 Ctrl+C 退出后，交互记录写入 `.runs/`。刷新页面保留正在运行的会话；重启则创建新会话。不要用此开发运行器执行不可信任务。

## 集成行为

输入接收返回 HTTP 202，不等待整个 Agent 空闲。原生会话事件通过顺序游标轮询；过期游标返回 410，不能静默丢失事件。输出属于主会话事件流，不独属于最近被接收的一条用户消息。客户端关联重叠工作时必须保留原生事件序号和轮次标识。

[播放队列](playback.mjs)让已经开始的接话自然结束，再播放主会话普通回复。按键打断递增播放周期，丢弃旧周期待播语音，分别记录已播和未播文本。下一次输入将这些回执作为已记录的应用上下文发送，原 Harness 回答历史仍然保留。虚拟字符时间轴不代表真实设备的词对齐，也不能证明用户理解。

## 限制

这是命令驱动实验室，不是正式 ESP32 服务。接话独立生成，主要回答和原生子任务在 Harness 中运行。真实 TTS 流式播放、固件采样回执、跨设备时钟误差、主机故障后的任务恢复，以及播放记录的持久化不在此原型范围。主会话沿用原生模型容量与压缩，不假设无限上下文。语音打断不会自动取消工作任务。

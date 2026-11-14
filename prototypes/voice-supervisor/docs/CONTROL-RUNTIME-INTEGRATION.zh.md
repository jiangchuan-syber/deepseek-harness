# Quick 取消与程序控制的集成候选

本候选前置是已运行的 fecc，自然短接话、无工具／off、主调度 Max 和既有简报汇报约束保留。组合 Quick PR4 fb45、控制 provider/trace PR5 26589、活跃准入与历史精确读取 PR6 d7bb，以及 outer 跨仓夹具 PR7 05665；不是把各条单独通过的结果直接算成集成通过。

实际合并保留两组状态：quick 的 native parent scope、最多两个未清理 provider、统一 probe 预算和迟到输出隔离；控制的 command/voice/goal、异步首次身份准备、原总 deadline、持久去重与只读恢复。取消 quick 不取消原用户目标；handled 控制任务不因旧 quick 被取代而重复交 deep。程序结果注入仍是内部事实，不伪造 LLM tool-call。

集成 source 回归 76/76 通过（3.490s）；真实 outer HTTP/SSE → 实际插件／私有 Python fixture broker → ESP32 候选 bridge/FlowTrace async 的独占进程测试通过，覆盖 Max 不可用仍响应、成功不二次播报、超时 unknown 不重写、旧事实不改挂新轮。完整 native Cordis/session bootstrap、真实模型语义、浏览器视觉、真实设备与物理一／三秒目标没有据此验收。通用总历史仍增长，只有准入和快照有界。

后续实际源反例证明普通 handoff 满额原本先返回 503，把有独立预算的控制一起挡住；失败日志保留，未改写此前 76 例结果。最小修复仅把受支持控制的有界准入与普通 handoff 限制分开，控制自身满额仍 503，未支持的控制仍回原限制，鉴权／输入校验仍先行。真实 outer 补充填满 32 条 handoff 后，一条控制仍独立 verified；额外控制、未支持控制和普通输入分别显式失败。SSE 背压导致的断开按实际游标重连，未重放动作。早期错误把原生快照的 1 条上限用于 outer 瞬时事件环，以及测试消费端未重连背压断开，均保留失败记录；没有修改业务限额来凑通过。

## 下次受控部署的配置迁移

1. 仅从精确 fecc 预镜像向此集成源生成文件级补丁；保留用户 `.env`、runtime settings、会话目录、日志和私有 inventory。备份及预镜像不符就停止，不把整棵工作树复制到生产。
2. 源 `overlay.yml` 新必需值是 `quick.cancelGraceMs: 50`、`quick.maxOutstanding: 2`。下次 interactive 启动从该源生成独占 runDir 的 overlay；不要只改旧 generated overlay，也不要等运行时才发现缺 key。
3. `simpleControl` 的来源为 `JSON.parse(process.env.VOICE_SIMPLE_CONTROL_CONFIG ?? '{"enabled":false}')`。本批默认不设置该变量，控制保持 disabled、不得启动 broker。私有 JSON 不提交，不以测试 fixture provider 或合成 token 替代实际配置。
4. 如后续单独允许启用台灯 provider，必须由真实唯一 home/DID hash、固定 Python 和工作区、时限、共享 CLI guard、mode/写权限共同配置；当前只有 lamp.power，不能声称四设备覆盖。不能带入 fixture 参数或测试进程的环境变量。
5. root 使用现有管理器预告后的标准 restart；同 requestId completed 后独立核源码／overlay、原生父会话、所有队列、当前固件和默认 off。此文档不是部署或新家电写入授权。

配套 ESP32 控制消费候选须前向合入最新 probe/RX/Flow 基线，不能覆盖其余已运行代码。先以 default-off 方式验证 Harness／桥启动和只读状态，再由单独窗口测真实动作与语音；独立脚本的软件读回成功不等于线上物理三秒通过。

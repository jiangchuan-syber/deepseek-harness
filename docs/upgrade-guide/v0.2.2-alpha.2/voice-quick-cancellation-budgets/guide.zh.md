---
kind: upgrade-guide
description: 自定义语音调度器 overlay 必须声明接话取消预算。
---

# 语音接话取消预算

[English](guide.md) | 中文

## 变更

可选语音调度器原型的自定义配置现在必须提供 `quick.cancelGraceMs` 和 `quick.maxOutstanding`。新输入取消同一原生父 Session 的过时接话，原始目标仍续接到深度处理。尚未结束的供应商清理占用有界槽位，不再挡住所有后续接话。主会话和子代理执行保持独立。

`/quick-probe` 现在要求通道空闲；存在接话或诊断调用时返回 HTTP 409。真实输入会取消诊断，尚未结束的清理仍占用槽位。

## 迁移

1. 使用仓库 `prototypes/voice-supervisor/overlay.yml` 时保留其中的新键。自定义 overlay 则在现有插件的 `quick` 对象下添加 `cancelGraceMs: 50` 和 `maxOutstanding: 2`。
2. `cancelGraceMs` 必须是正整数且不超过 `timeoutMs`；`maxOutstanding` 只能为 `1` 或 `2`。预算合计正在调用和尚未结束的供应商调用。达到上限时明确报告接话失败、快速回应为空，原始输入仍交给原生主会话。
3. 按原型 [README](../../../../prototypes/voice-supervisor/README.zh.md) 执行检查。查看 `/state` 的 `quickCleanupPending` 与 `quickOutstanding`；被淘汰的接话不得迟到发布文字或完成事件，关闭过程也不能在供应商清理结束前假称已经结束。

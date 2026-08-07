---
sidebar_position: 6
title: 架构
---

# 架构

## 当前真实执行链

```text
CLI / Cron / HTTP API
        │
        ▼
Gateway ──► FIFO Queue（daemon/API）
        │
        ├─ 加载并严格校验 SKILL.md
        ├─ 递归展开 dependsOn，去重并排序
        ▼
SessionManager ──► Cookie 恢复 / 可见窗口人工登录
        │
        ▼
TaskRunner（顺序执行、超时、重试）
        │
        ▼
StepExecutor
  ├─ AI 原子操作：Midscene 截图 + 视觉模型 + Playwright
  └─ 确定性操作：Playwright 键盘 / 鼠标 / 等待 / 截图
        │
        ├─ JSONL transcript
        ├─ 失败现场 PNG
        └─ state.json 运行摘要
```

项目不是一个自由循环直到模型返回 `done` 的通用 Agent。它执行 `SKILL.md` 中有界、可审计的 `## Steps` 工作流；其中 `aiAct` 可以在单个步骤内部让 Midscene 规划多个动作。

## 关键语义

- `Background`、`Goal`、`Known Issues` 被注入 `aiActionContext`，为每个 AI 步骤提供共享约束。
- `enabled` 是技能目录的推荐状态；真正的执行集合由 `tasks.enabled`、`--tasks` 或 `--routine` 决定。
- `dependsOn` 会自动加入前置技能。例如运行 `claim-mail` 会先运行 `welkin-moon`。
- 同一 ID 出现在多个 `skillsDirs` 时，后面的目录覆盖前面的目录，允许用户定制内置技能。
- 未知任务、空 Steps、未知原子操作、目录名与 ID 不一致、依赖环都会在启动或 dry-run 阶段失败。
- 单技能失败会按 `retries` 重试；最终失败不会阻止后续独立技能执行。
- CLI `run` 直接执行；daemon 和 HTTP API 使用有最大深度限制的串行 FIFO 队列。

## 可验证边界

构建、单元测试和 dry-run 能证明配置、加载、依赖与编排层正常，但不能替代真实云游戏验收。当前已有 5 个奖励任务完成真实账号全流程验证，探索派遣暂停。账号、Cookie、云游戏排队、版本 UI、视觉模型和网络任一变化后，仍应使用可见模式进行针对性回归。

---
sidebar_position: 6
title: 架构
---

# 架构

## 整体架构

```
┌─────────────────────────────────────────────────┐
│  skills/*.md          Markdown 技能定义          │
└────────────┬────────────────────────────────────┘
             │ load
┌────────────▼────────────────────────────────────┐
│            Gateway (control plane)               │
│  ┌──────────────────────────────────────────┐   │
│  │  Agent Loop (observe → think → act)      │   │
│  │  ┌──────────┐ ┌───────┐ ┌────────┐      │   │
│  │  │  Model   │ │ Tools │ │ Memory │      │   │
│  │  │ (Vision) │ │(Mouse)│ │ (JSONL)│      │   │
│  │  └──────────┘ └───────┘ └────────┘      │   │
│  └──────────────────────────────────────────┘   │
│  Scheduler · Queue · StateStore                  │
└──────────┬──────────────────┬───────────────────┘
           │                  │
    ┌──────▼──────┐   ┌──────▼──────┐
    │  TUI (ink)  │   │ Web (Fastify)│
    └─────────────┘   └─────────────┘
```

## 核心组件

- **Model** — 纯 HTTP，接收 base64 截图，返回坐标 / action plan
- **Tools** — Playwright 浏览器操作：click、scroll、type、press-key
- **Memory** — JSONL transcript + 运行历史持久化
- **Agent Loop** — 组合三层，observe → think → act 直到 `done`
- **Gateway** — 统一协调：加载技能、调度 cron、管理队列、暴露 API

## 工作流程

1. **加载技能**：从 `skills/` 目录读取 `SKILL.md` 文件，解析 frontmatter 和 Markdown 正文
2. **调度执行**：按 cron 或手动触发，将技能放入执行队列
3. **Agent Loop**：对每个技能执行 observe → think → act 循环
   - **Observe**：截取浏览器截图
   - **Think**：将截图发送给视觉模型，获取操作指令
   - **Act**：通过 Playwright 执行浏览器操作
4. **持久化**：将执行过程记录为 JSONL transcript

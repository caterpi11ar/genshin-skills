---
sidebar_position: 1
title: 技能概述
---

# 技能系统

技能是 genshin-impact-claw 的任务单元。每个技能是一个 `SKILL.md` 文件，包含 YAML frontmatter（机器配置）和 Markdown 正文（AI 指令）。添加新技能只需写一个 Markdown 文件，无需编写 TypeScript 代码。

## 技能结构

```
skills/<skill-id>/SKILL.md
```

任务通过**文件驱动的技能系统**定义。每个技能是一个 `SKILL.md`——YAML frontmatter 定义配置，Markdown 正文定义 AI 指令。

## 内置技能

| ID | 名称 | 说明 |
|----|------|------|
| `welkin-moon` | 月卡每日领取 | 登录 → 启动游戏 → 领取月卡奖励 |
| `claim-mail` | 邮件领取 | 打开邮箱 → 一键领取所有附件 |
| `expedition-collect` | 探索派遣收取 | 冒险之证 → 收取已完成派遣 → 重新派遣 |
| `battle-pass-claim` | 纪行奖励领取 | 打开纪行 → 领取可领取的等级奖励 |

所有技能按 `config.json` 中 `tasks.enabled` 的顺序在同一浏览器会话中依次执行。`welkin-moon` 负责启动游戏，后续技能从游戏内界面继续操作。

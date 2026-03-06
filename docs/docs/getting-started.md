---
sidebar_position: 1
title: 快速开始
---

# 快速开始

Genshin Impact Claw（`giclaw`）是专为原神服务的智能体。通过视觉模型分析游戏截图，自动完成云原神的日常任务——登录、领取月卡、收取邮件、探索派遣、纪行奖励。

无需选择器、无需坐标硬编码。截图发给 AI，AI 决定下一步操作。

## 开始使用

```bash
# 1. 安装
npm install -g genshin-impact-claw@latest

# 2. 配置模型（任意 OpenAI 兼容视觉模型）
export MIDSCENE_MODEL_NAME=gemini-2.5-flash
export MIDSCENE_MODEL_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
export MIDSCENE_MODEL_API_KEY=your-api-key
export MIDSCENE_MODEL_FAMILY=gemini

# 3. 首次运行（可见浏览器，手动登录后自动保存 cookie）
giclaw run --no-headless

# 4. 后续运行（headless，复用 cookie）
giclaw run
```

首次需要手动登录米哈游账号，登录后 cookie 自动保存到 `cookies.json`，后续运行自动复用。

## 验证配置

```bash
giclaw run --dry-run
```

`--dry-run` 仅验证配置是否正确，不会实际执行任务。

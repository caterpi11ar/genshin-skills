---
sidebar_position: 3
title: 配置
---

# 配置

三层覆盖优先级：`config.json` &lt; 环境变量 &lt; CLI 参数。

## config.json

```json
{
  "model": {
    "name": "gemini-2.5-flash",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "apiKey": "sk-xxx",
    "family": "gemini"
  },
  "tasks": {
    "enabled": ["welkin-moon", "claim-mail", "expedition-collect", "battle-pass-claim"],
    "skillsDirs": ["./skills"]
  },
  "schedule": { "cron": "0 6 * * *", "timezone": "Asia/Shanghai" },
  "browser": { "headless": true }
}
```

## 环境变量

模型也可通过环境变量配置。支持任意 OpenAI 兼容视觉模型：Gemini、Qwen-VL、豆包 Seed 等。

```bash
# Vision model configuration
MIDSCENE_MODEL_NAME=gemini-2.5-flash
MIDSCENE_MODEL_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
MIDSCENE_MODEL_API_KEY=your-api-key-here
MIDSCENE_MODEL_FAMILY=gemini

# Browser (optional)
# BROWSER_HEADLESS=true
```

可以将以上变量写入项目根目录的 `.env` 文件，程序启动时自动加载。

## 配置项说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `model.name` | 模型名称 | - |
| `model.baseUrl` | OpenAI 兼容 API 地址 | - |
| `model.apiKey` | API 密钥 | - |
| `model.family` | 模型系列（`gemini`、`openai` 等） | - |
| `tasks.enabled` | 启用的技能 ID 列表 | 所有技能 |
| `tasks.skillsDirs` | 技能目录路径 | `["./skills"]` |
| `schedule.cron` | Cron 表达式 | `"0 6 * * *"` |
| `schedule.timezone` | 时区 | `"Asia/Shanghai"` |
| `browser.headless` | 是否无头模式 | `true` |

---
sidebar_position: 2
title: 配置
---

# 配置

推荐通过 `giclaw init` 交互式引导完成模型配置。也可以手动编辑配置文件。

两层覆盖优先级：`config.json` < CLI 参数。

## 配置文件路径

所有配置统一在 `~/.giclaw/config.json` 中管理。`giclaw init` 交互式引导会自动写入该文件。也可以在项目根目录放置 `config.json`，程序启动时优先加载。

## 完整示例

```json
{
  "locale": "zh",
  "model": {
    "name": "gpt-5.6-sol",
    "baseUrl": "http://127.0.0.1:3002/v1",
    "apiKey": "你的 NewAPI 用户令牌",
    "family": "gpt-5",
    "stream": true
  },
  "tasks": {
    "enabled": ["welkin-moon", "claim-mail"],
    "skillsDirs": ["./skills"],
    "routines": {
      "daily": ["welkin-moon", "claim-mail"],
      "rewards": ["welkin-moon", "claim-mail", "claim-achievements", "claim-event-rewards", "battle-pass-claim"],
      "full": ["welkin-moon", "claim-mail", "claim-achievements", "claim-event-rewards", "expedition-collect", "battle-pass-claim"]
    }
  },
  "schedule": { "cron": "0 6 * * *", "timezone": "Asia/Shanghai" },
  "browser": {
    "headless": true,
    "startupUrl": "https://ys.mihoyo.com/cloud/",
    "viewport": { "width": 1280, "height": 720 },
    "dialogAutoDismissMs": 10000
  },
  "login": {
    "successSelector": ".wel-card__content--start",
    "timeoutMs": 300000,
    "pollIntervalMs": 500
  },
  "startGame": {
    "startSelector": ".wel-card__content--start",
    "dismissSelectors": [".guide-close-btn"]
  },
  "web": { "port": 3000, "enabled": true },
  "memory": { "dataDir": "~/.giclaw/data", "maxHistory": 100 },
  "queue": { "maxDepth": 10 },
  "logLevel": "info"
}
```

## 配置项参考

### 基础

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `locale` | AI 提示词语言（`"zh"` 中文、`"en"` English） | `"zh"` |
| `logLevel` | 日志级别：`debug`、`info`、`warn`、`error` | `"info"` |

### 模型

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `model.name` | 上游实际提供的模型名称；当前已验收环境使用 `gpt-5.6-sol` | `""` |
| `model.baseUrl` | OpenAI 兼容 API 地址 | `""` |
| `model.apiKey` | API 密钥 | `""` |
| `model.family` | Midscene 使用的模型家族；GPT 5.x 兼容模型使用 `"gpt-5"` | `""` |
| `model.stream` | 强制以流式 Chat Completions 请求上游，并在项目内聚合为完整响应 | `false` |

详细的模型配置示例请参考[模型配置指南](./models)。

### 任务

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `tasks.enabled` | 默认执行的技能 ID 列表 | `["welkin-moon", "claim-mail"]` |
| `tasks.skillsDirs` | 技能目录搜索路径 | `["<内置技能目录>", "./skills", "~/.giclaw/skills"]` |
| `tasks.routines` | 命名一条龙流程；用 `--routine <name>` 运行 | `daily`、`rewards`、`full` |

默认命名流程的含义：

- `daily`：月卡 + 邮件，也是默认启用集合。
- `rewards`：月卡、邮件、成就、活动和纪行；这 5 个任务均已通过真实账号验收，是当前推荐的完整奖励流程。
- `full`：在 `rewards` 基础上加入探索派遣。该能力当前暂停，默认 schema 尚未移除它，因此现阶段应使用 `rewards`，或在自己的 `tasks.routines.full` 中显式调整。

### 调度

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `schedule.cron` | Cron 表达式（Daemon 模式定时触发） | `"0 6 * * *"` |
| `schedule.timezone` | 时区 | `"Asia/Shanghai"` |

### 浏览器

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `browser.headless` | 是否无头模式运行 | `true` |
| `browser.startupUrl` | 云原神启动页 URL | `"https://ys.mihoyo.com/cloud/"` |
| `browser.viewport.width` | 浏览器视口宽度（像素） | `1280` |
| `browser.viewport.height` | 浏览器视口高度（像素） | `720` |
| `browser.cookieFilePath` | Cookie 持久化文件路径 | `"~/.giclaw/cookies.json"` |
| `browser.dialogAutoDismissMs` | 浏览器弹窗自动关闭等待时间（毫秒） | `10000` |

### 登录

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `login.successSelector` | 登录成功后检测的 CSS 选择器 | `".wel-card__content--start"` |
| `login.timeoutMs` | 等待手动登录的超时时间（毫秒） | `300000`（5 分钟） |
| `login.pollIntervalMs` | 检测登录状态的轮询间隔（毫秒） | `500` |

### 启动游戏

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `startGame.startSelector` | "开始游戏"按钮的 CSS 选择器 | `".wel-card__content--start"` |
| `startGame.dismissSelectors` | 启动后需要关闭的引导弹窗选择器列表 | `[".guide-close-btn"]` |

### Web 面板

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `web.enabled` | 是否启用 Web 面板（Daemon 模式） | `true` |
| `web.port` | Web 面板监听端口 | `3000` |

### 内存 / 持久化

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `memory.dataDir` | 数据存储目录（transcript、截图等） | `"~/.giclaw/data"` |
| `memory.maxHistory` | 保留的运行历史记录条数 | `100` |

### 队列

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `queue.maxDepth` | 任务队列最大深度（防止堆积） | `10` |

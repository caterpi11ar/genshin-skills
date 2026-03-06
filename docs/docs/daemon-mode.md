---
sidebar_position: 5
title: Daemon 模式
---

# Daemon 模式

常驻后台，按 cron 定时执行，支持 TUI 仪表盘 + Web 面板。

## 启动

```bash
giclaw daemon

# 指定端口 / 禁用 Web
giclaw daemon --port 8080
giclaw daemon --no-web
```

## 默认行为

- **调度**：每天 06:00（Asia/Shanghai）
- **TUI**：TTY 环境自动渲染 ink 仪表盘
- **非 TTY**：回退到纯日志输出
- **Web 面板**：默认启用，监听端口 3000

## 自定义调度

通过 `config.json` 修改 cron 表达式和时区：

```json
{
  "schedule": {
    "cron": "0 6 * * *",
    "timezone": "Asia/Shanghai"
  }
}
```

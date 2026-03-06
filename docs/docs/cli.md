---
sidebar_position: 4
title: CLI 参考
---

# CLI 参考

```
giclaw [options] [command]
```

## 命令

| 命令 | 说明 |
|------|------|
| `run` | 单次运行（默认） |
| `daemon [options]` | Daemon 模式 |

## 全局选项

| 选项 | 说明 |
|------|------|
| `-c, --config <path>` | 配置文件路径（默认 `./config.json`） |
| `-t, --tasks <ids...>` | 指定运行的任务 |
| `--headless / --no-headless` | 启用/禁用无头模式 |
| `--dry-run` | 仅验证配置 |
| `-v, --verbose` | 调试日志 |

## Daemon 选项

| 选项 | 说明 |
|------|------|
| `-p, --port <number>` | Web 面板端口（默认 3000） |
| `--no-web` | 禁用 Web 面板 |

## 示例

```bash
# 单次运行所有已启用任务
giclaw run

# 首次运行，手动登录
giclaw run --no-headless

# 仅运行指定任务
giclaw run --tasks welkin-moon claim-mail

# 验证配置
giclaw run --dry-run

# 启动 daemon 模式
giclaw daemon

# 指定端口
giclaw daemon --port 8080

# 禁用 Web 面板
giclaw daemon --no-web
```

# Genshin Impact Claw

专为原神服务的智能体。

通过视觉模型分析游戏截图，自动完成云原神的日常任务——登录、领取月卡、收取邮件、探索派遣、纪行奖励。无需选择器、无需坐标硬编码。截图发给 AI，AI 决定下一步操作。

[技能列表](skills/README.md) · [配置参考](.env.example) · [官网](https://giclaw.cn)

## Install（推荐）

运行环境：**Node >= 20**

```bash
npm install -g giclaw@latest
# or: pnpm add -g giclaw@latest
```

安装后全局可用 `giclaw` 命令。首次运行时自动下载 Chromium，无需手动安装。

## Quick start

```bash
# 1. 交互式配置（选择模型提供商、填写 API key）
giclaw init

# 2. 首次运行（可见浏览器，手动登录后自动保存 cookie）
giclaw run --no-headless

# 3. 后续运行（headless，复用 cookie）
giclaw run

# 4. 验证配置
giclaw run --dry-run
```

`giclaw init` 会引导你选择模型提供商（Gemini、OpenAI、豆包、通义千问等）并配置 API key，配置保存到 `~/.giclaw/.env`。如果跳过 init 直接运行，程序会自动触发引导。

首次需要手动登录米哈游账号，登录后 cookie 自动保存到 `cookies.json`，后续运行自动复用。

## From source（开发）

推荐使用 `pnpm`。

```bash
git clone https://github.com/caterpi11ar/giclaw.git
cd giclaw

pnpm install
pnpm build

# 单次运行
pnpm start

# Dev loop（auto-reload on TS changes）
pnpm dev
```

Note: `pnpm dev` 通过 `tsx watch` 直接运行 TypeScript。`pnpm build` 产出 `dist/`，通过 `pnpm start` 或全局 `giclaw` 命令运行。

## Daemon 模式

常驻后台，按 cron 定时执行，支持 TUI 仪表盘 + Web 面板：

```bash
giclaw daemon

# 指定端口 / 禁用 Web
giclaw daemon --port 8080
giclaw daemon --no-web
```

默认调度：每天 06:00（Asia/Shanghai）。TTY 环境自动渲染 ink 仪表盘，非 TTY 回退到纯日志。

## Configuration

三层覆盖：`config.json` < 环境变量 < CLI 参数。

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

模型也可通过环境变量配置（见 [`.env.example`](.env.example)）。支持任意 OpenAI 兼容视觉模型：Gemini、Qwen-VL、豆包 Seed 等。

## Skills

任务通过**文件驱动的技能系统**定义。每个技能是一个 `SKILL.md`——YAML frontmatter 定义配置，Markdown 正文定义 AI 指令。添加新技能只需写一个 Markdown 文件，无需 TypeScript。

```
skills/welkin-moon/SKILL.md    # 月卡领取
skills/claim-mail/SKILL.md     # 邮件领取
skills/expedition-collect/SKILL.md  # 探索派遣
skills/battle-pass-claim/SKILL.md   # 纪行奖励
```

技能格式、编写指南及完整列表：[`skills/README.md`](skills/README.md)

## How it works

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

- **Model** — 纯 HTTP，接收 base64 截图，返回坐标 / action plan
- **Tools** — Playwright 浏览器操作：click、scroll、type、press-key
- **Memory** — JSONL transcript + 运行历史持久化
- **Agent Loop** — 组合三层，observe→think→act 直到 `done`
- **Gateway** — 统一协调：加载技能、调度 cron、管理队列、暴露 API

## CLI

```
giclaw [options] [command]

Commands:
  run                     单次运行（默认）
  daemon [options]        Daemon 模式
  init [options]          交互式初始化配置
  config                  显示配置路径

Options:
  -c, --config <path>     配置文件路径（默认 ./config.json）
  -t, --tasks <ids...>    指定运行的任务
  --headless / --no-headless
  --dry-run               仅验证配置
  -v, --verbose           调试日志

Daemon:
  -p, --port <number>     Web 面板端口（默认 3000）
  --no-web                禁用 Web 面板

Init:
  --non-interactive       跳过交互引导，仅创建默认文件
```

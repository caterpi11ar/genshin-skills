# Genshin Auto

AI 视觉驱动的原神云游戏自动化工具。通过 OpenAI 兼容的视觉模型分析截图坐标，自动完成云原神登录、启动游戏、领取月卡等日常任务。

## 运行模式

### 单次运行（默认）

执行一次完整的任务流程后退出，适合手动触发或 cron 调度：

```bash
# 开发模式
npx tsx src/cli.ts

# 编译后运行
npm run build
node dist/cli.js
```

### Daemon 模式

常驻后台进程，按 cron 表达式定时执行任务：

```bash
npx tsx src/cli.ts daemon

# 或指定端口、禁用 Web 面板
npx tsx src/cli.ts daemon --port 8080
npx tsx src/cli.ts daemon --no-web
```

默认调度：每天早上 6:00（Asia/Shanghai），可通过 `config.json` 或环境变量修改。

### TUI 仪表盘

Daemon 模式在终端中自动渲染交互式仪表盘（基于 [ink](https://github.com/vadimdemedes/ink)），实时展示：

- **Status** — 运行状态（Idle / Running + 当前任务名）
- **Last Run** — 上次运行结果（成功/失败、耗时、错误信息）
- **Logs** — 最近 15 条日志，按 level 着色

快捷键：`r` 手动触发运行 · `c` 清除日志 · `q` 退出

> 非 TTY 环境（Docker、管道等）自动回退到纯日志输出。

### Web 面板（可选）

Daemon 模式下可启用 Web 面板，访问 `http://localhost:3000`：

- **Status** — 运行状态、手动触发按钮
- **Logs** — WebSocket 实时日志流
- **Config** — 当前配置（API key 已脱敏）

## CLI

```
genshin-auto [options] [command]

Commands:
  run                     单次运行（默认）
  daemon [options]        Daemon 模式

Options:
  -c, --config <path>     配置文件路径（默认 ./config.json）
  -t, --tasks <ids...>    指定运行的任务
  --headless              强制 headless 模式
  --no-headless           强制可见浏览器
  --dry-run               仅验证配置，不执行
  -v, --verbose           调试日志
  -V, --version           版本号
  -h, --help              帮助信息

Daemon 选项:
  -p, --port <number>     Web 面板端口（默认 3000）
  --no-web                禁用 Web 面板
```

## 配置

支持三层配置覆盖：`config.json` < 环境变量 < CLI 参数。

### config.json 示例

```json
{
  "browser": {
    "headless": true,
    "cookieFilePath": "./cookies.json"
  },
  "model": {
    "name": "qwen-vl-max",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "sk-xxx"
  },
  "tasks": {
    "enabled": ["welkin-moon"]
  },
  "schedule": {
    "cron": "0 6 * * *",
    "timezone": "Asia/Shanghai"
  },
  "memory": {
    "dataDir": "./data",
    "maxHistory": 100
  },
  "queue": {
    "maxDepth": 10
  }
}
```

### 环境变量

模型配置也可通过 `.env` 或环境变量设置：

```bash
MIDSCENE_MODEL_NAME=qwen-vl-max
MIDSCENE_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MIDSCENE_MODEL_API_KEY=sk-xxx
MIDSCENE_MODEL_FAMILY=openai
```

支持任意 OpenAI 兼容的视觉模型（Qwen-VL、豆包 Seed、Gemini 等）。

## 任务架构

所有阶段统一使用**坐标分析**：截图 → AI 视觉模型识别元素坐标 → `page.mouse.click(x, y)`。

这种方式同时适用于 DOM 渲染的网页 UI 和 canvas 渲染的云游戏画面，避免了脆弱的 CSS 选择器。

流程：
1. Playwright 对页面截图
2. 截图发送给 OpenAI 兼容的视觉模型（Qwen-VL 等），要求返回目标元素的像素坐标
3. 在返回的坐标位置执行鼠标点击

### 当前任务

| ID | 名称 | 说明 |
|----|------|------|
| `welkin-moon` | 月卡每日领取 | 登录 → 启动游戏 → 等待月卡弹窗 → 领取奖励 → 截图存证 |

## 项目结构

```
src/
  cli.ts                    CLI 入口（commander），解析参数后调用 Gateway
  gateway/                  中央协调器
    gateway.ts              Gateway 类 — 拥有所有子系统，对外统一接口
    lifecycle.ts            启动/关闭编排，信号处理
    scheduler.ts            Cron 调度（封装 node-cron）
    state.ts                GatewayState — 可观察的运行时状态（EventEmitter）
    types.ts                接口定义
  model/                    模型层（纯 HTTP，不依赖 Page）
    vision-model.ts         VisionModel — 接收 base64 图片，返回解析结果
    prompts.ts              所有 prompt 模板（中文），纯函数
    types.ts                VisionModelConfig, ActionPlan, Coordinates 等
  tools/                    工具层（仅依赖 Playwright Page）
    browser-tools.ts        离散浏览器动作 + dispatcher
    screenshot.ts           截图 + base64 编码
    types.ts                ToolResult, BrowserAction
  agent/                    Agent 循环
    agent-loop.ts           observe->think->act 循环（组合 Model + Tools + Memory）
    types.ts                AgentContext, AgentResult
  memory/                   记忆层（仅依赖 node:fs）
    transcript.ts           JSONL 追加写入执行记录
    state-store.ts          持久化运行状态（上次结果、运行历史）
    types.ts                TranscriptEntry, PersistedState
  queue/                    任务队列
    task-queue.ts           串行 FIFO 队列，替代 boolean flag
    types.ts                QueueItem, QueueStatus
  tasks/
    base-task.ts            TaskDefinition / TaskResult 类型定义
    task-runner.ts          顺序执行 + 重试 + 事件发射
    welkin-moon.ts          月卡领取任务（薄层：定义目标 -> 委托 agent-loop）
    index.ts                任务注册
  browser/
    session-manager.ts      单会话浏览器管理（launch/relaunch/close）
    login.ts                Cookie 登录流程
    cookie-store.ts         Cookie 文件读写
  config/
    schema.ts               Zod 配置 schema（含 memory/queue 配置段）
    loader.ts               多层配置加载与合并
  tui/
    render.tsx              ink 渲染入口（接收 Gateway）
    Dashboard.tsx           TUI 主组件（订阅 gateway.state）
    components/
      StatusBar.tsx         运行状态指示
      TaskResults.tsx       任务结果列表
      LogPanel.tsx          日志面板
  web/
    server.ts               Fastify HTTP + 静态文件（接收 Gateway）
    ws.ts                   WebSocket 实时推送
    api.ts                  REST API（从 Gateway 读取状态）
    public/index.html       单文件 SPA
  utils/
    logger.ts               日志（EventEmitter，供 TUI / WebSocket 订阅）
    errors.ts               错误类型层级
    delay.ts                delay() + retry()
```

### 四层架构

```
Model（纯模型调用）-> Tools（浏览器操作）-> Memory（持久化）
                    \         |         /
                      Agent Loop（组合三层）
                            |
                    Gateway（统一协调器）
                      /         \
                   TUI          Web
```

耦合规则：
- **Model 层**：零依赖（纯 HTTP + JSON 解析），不接触 Playwright Page
- **Tools 层**：仅依赖 Playwright `Page`
- **Memory 层**：仅依赖 `node:fs`
- **Agent Loop**：组合 Model + Tools + Memory
- **Gateway**：组合所有层，对外唯一接口
- **TUI / Web**：仅依赖 Gateway（不直接 import 内部模块）

## 快速开始

```bash
# 安装依赖
pnpm install
npx playwright install chromium

# 验证配置
npx tsx src/cli.ts --dry-run

# 首次运行（会打开可见浏览器，手动登录后自动保存 cookie）
npx tsx src/cli.ts --no-headless

# 后续运行（headless，自动使用已保存的 cookie）
npx tsx src/cli.ts
```

## 开发

```bash
pnpm run dev          # tsx watch 模式
pnpm run build        # tsc 编译
pnpm run test         # vitest
```

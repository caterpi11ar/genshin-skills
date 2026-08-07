<p align="center">
  <img src="docs/static/img/logo.jpeg" width="180" alt="Giclaw Logo" />
</p>

<h1 align="center">Giclaw</h1>

<p align="center">
  <strong>Genshin Impact Claw — 专为原神服务的视觉 AI 智能体</strong>
</p>

<p align="center">
  <a href="https://giclaw.cn">文档</a> · <a href="https://giclaw.cn/docs/getting-started">快速开始</a> · <a href="https://giclaw.cn/docs/skills/built-in-skills">技能列表</a> · <a href="https://giclaw.cn/docs/changelog">更新日志</a>
</p>

---

通过视觉模型理解游戏截图，并结合可审计的确定性键鼠步骤，自动完成云原神中的月卡、邮件、纪行、成就和活动奖励领取。

## 特性

- **视觉 + 确定性操作** — 视觉 AI 处理变化界面，固定键鼠步骤处理稳定入口
- **文件驱动技能** — 写一个 Markdown 就能定义新任务，无需 TypeScript
- **多模型支持** — Gemini、OpenAI、豆包、通义千问，任意 OpenAI 兼容视觉 API
- **共享游戏上下文** — 通用 UI 规则（鼠标锁定、HUD 布局、云游戏侧边栏）自动注入，技能只需关注自身逻辑
- **Daemon 模式** — cron 定时调度 + TUI 仪表盘 + Web 面板
- **一条龙编排** — 技能依赖自动展开，支持 `daily` / `rewards` / `full` 命名流程
- **混合原子操作** — 视觉 AI 定位 + 确定性键鼠回放，共 22 种技能原子操作
- **失败可诊断** — 严格技能校验、JSONL 逐步记录、失败现场自动截图
- **云游戏适配** — 无需本地安装原神客户端，低资源占用

## 安装

运行环境：**Node >= 20**

```bash
npm install -g giclaw@latest
```

## 快速开始

```bash
giclaw init                  # 交互式配置
giclaw run --no-headless     # 首次运行，手动登录
giclaw run                   # 后续运行，自动执行
```

详细指南请访问 [文档站点](https://giclaw.cn/docs/getting-started)。

## 内置技能

| 技能 | 说明 | 默认状态 | 真实账号验收 |
|------|------|----------|--------------|
| `welkin-moon` | 启动云游戏，领取月卡每日奖励 | 启用 | 已通过 |
| `claim-mail` | 打开邮箱，一键领取所有邮件附件 | 启用 | 已通过 |
| `battle-pass-claim` | 打开纪行，领取等级奖励 | 关闭 | 已通过 |
| `claim-achievements` | 领取已完成成就奖励 | 关闭 | 已通过 |
| `claim-event-rewards` | 领取已解锁活动奖励 | 关闭 | 已通过 |
| `expedition-collect` | 收取探索派遣并重新派遣 | 关闭 | 暂停，尚未完成领取与再次派遣闭环 |

```bash
giclaw skills                 # 查看技能、依赖、一条龙流程和原子操作
giclaw run --routine daily    # 月卡 + 邮件
giclaw run --routine rewards  # 运行已通过真实账号验收的 5 个任务
```

`full` 流程当前仍包含已暂停的 `expedition-collect`，不建议直接运行；需要完整奖励领取时使用 `rewards`。

自定义技能只需在 `~/.giclaw/skills/` 下创建 `SKILL.md`，详见 [编写技能](https://giclaw.cn/docs/skills/writing-skills)。

## License

MIT

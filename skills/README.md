# Skills

每个技能位于 `skills/<skill-id>/SKILL.md`，由 YAML frontmatter、共享 AI 上下文和可执行 `## Steps` 组成。

```markdown
---
id: my-skill
name: My Skill
description: A short description.
enabled: false
timeoutMs: 300000
retries: 0
dependsOn:
  - welkin-moon
---

## Background
当前游戏场景。

## Goal
目标和安全边界。

## Steps
- keyPress: Escape
- aiWaitFor: 派蒙菜单已经打开
- aiTap: 目标图标
- screenshot: completed

## Known Issues
- 容易误判的界面及处理规则。
```

支持 22 个原子操作：

- 视觉 AI：`aiAct`、`aiTap`、`aiRightClick`、`aiHover`、`aiInput`、`aiKeyboardPress`、`aiScroll`、`aiWaitFor`、`aiAssert`、`aiBoolean`
- 确定性操作：`click`、`rightClick`、`move`、`scroll`、`type`、`keyPress`、`keyDown`、`keyUp`、`mouseDown`、`mouseUp`、`wait`、`screenshot`

`Background`、`Goal` 和 `Known Issues` 会注入视觉 Agent。`dependsOn` 会自动展开、去重和排序。后面的 `skillsDirs` 可用同 ID 覆盖前面的内置技能。

UI 工作流一旦执行过部分步骤就不再具备可靠起点，因此 `retries` 目前只能为 `0`。失败会立即停止整次运行；确认现场后再由用户重新启动，避免在未知界面重复领取或误点。

```bash
giclaw skills
giclaw run --dry-run --tasks my-skill
giclaw run --no-headless --tasks my-skill
```

完整参数格式见文档站的“编写技能”页面。

## 内置能力状态

| ID | 默认状态 | 真实账号验收 |
|---|---|---|
| `welkin-moon` | 启用 | 已通过 |
| `claim-mail` | 启用 | 已通过 |
| `battle-pass-claim` | 启用 | 已通过 |
| `claim-achievements` | 启用 | 已通过 |
| `claim-event-rewards` | 启用 | 已通过 |
| `expedition-collect` | 关闭 | 暂停，未完成领取与再次派遣闭环 |

默认直接运行全部 5 个已验收任务；使用 `daily` 可以只运行月卡和邮件，`rewards` 与 `full` 都只包含已验收奖励流程。暂停的探索派遣不会被任何默认流程调用。

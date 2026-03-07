---
id: claim-mail
name: Claim Mail Rewards
description: Open the in-game mailbox and claim all pending mail rewards.
enabled: true
timeoutMs: 300000
retries: 1
---

## Background

原神云游戏中操作，游戏已加载完毕。屏幕最左侧有云游戏平台侧边栏（不可点击），派蒙菜单内容在其右侧。

## Steps

- keyPress: Escape
- aiWaitFor: 派蒙菜单已打开，可以看到菜单面板和左侧图标栏
- aiTap: 派蒙菜单左侧图标栏中信封形状的邮件图标（在圆形角色头像下方，注意不要点击屏幕最左边缘的云游戏平台图标）
- aiWaitFor: 邮箱界面已打开，顶部显示「邮箱」标题和邮件数量
- aiAct: 查看底部「全部领取」按钮。如果可点击（绿色），点击它领取所有邮件附件；如果不可点击（灰色）或邮件列表为空，不做操作
- aiAct: 如果弹出物品展示窗口，点击空白处关闭
- keyPress: Escape
- aiWaitFor: 回到游戏主界面

## Known Issues

- 派蒙菜单打不开：可能在对话或其他界面中，先按 Escape 退出
- 误点角色头像打开了名片选择界面：点 ✕ 关闭后在更下方找信封图标
- 误入拍照模式（出现 F1/F2 提示）：按 Esc 退出，向右偏移找图标

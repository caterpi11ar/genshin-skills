---
id: welkin-moon
name: Welkin Moon Daily Claim
description: Log in to Genshin cloud gaming, start the game, and claim the Welkin Moon daily reward.
enabled: true
timeoutMs: 600000
retries: 1
---

## Background

你正在原神云游戏网页上操作。页面有游戏画布和各种 UI 覆盖层。这是云游戏平台，启动游戏前可能需要排队等待。

## Steps

- aiAct: 如果页面上有「开始游戏」按钮，点击它启动游戏
- aiWaitFor: 游戏开始加载或正在排队中（如果排队则继续等待，不要点击退出排队）
- aiAct: 如果出现任何用户协议、隐私政策弹窗，点击「同意」或「确认」按钮将其关闭；如果没有弹窗则不做操作
- aiWaitFor: 游戏主界面已加载完成，可以看到角色站在游戏世界中（如果有公告弹窗遮挡，先关闭它）
- aiAct: 如果出现任何公告、引导弹窗（如「保存网页地址」），点击关闭按钮或确认按钮将其关闭；如果没有弹窗则不做操作
- aiAct: 如果屏幕中央出现月卡（空月祝福）奖励领取弹窗，点击领取按钮领取奖励；如果没有弹窗则不做操作
- aiAct: 如果弹出物品展示窗口，点击空白处关闭

## Known Issues

- 「保存网页地址」引导弹窗：关闭按钮（×）在弹窗右上角，多次点击无效请按 Escape
- 排队画面（显示「排队中」「前方X人」）：正常流程，等待即可，绝不点击退出排队
- 用户协议/隐私政策弹窗：必须先点击「同意」才能继续加载游戏
- 画布未激活：点击画面中央激活
- 加载画面：等待，不要点击

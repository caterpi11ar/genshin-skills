---
id: claim-achievements
name: Claim Achievement Rewards
description: Open the achievements interface and claim all available Primogem rewards.
enabled: true
timeoutMs: 300000
retries: 0
dependsOn:
  - welkin-moon
---

## Background

游戏已经进入主界面。成就入口位于派蒙菜单；有奖励可领时会出现红点。只领取已经完成的成就，不改变展示成就等其他设置。

## Goal

进入成就界面并领取所有已完成成就的原石奖励，然后可靠地回到游戏主界面。

## Steps

- keyPress: Escape
- aiWaitFor: 派蒙菜单已打开，鼠标已解锁
- aiTap: 派蒙菜单中的「成就」入口；避开屏幕最左侧的云游戏平台侧边栏
- aiWaitFor: 成就分类界面已打开
- aiAct: 逐个打开带红点的成就分类并点击所有「领取」按钮；重复处理直到所有可见分类都不再有红点。如果没有红点或没有可领取奖励，不做领取操作
- aiAct: 如果出现奖励展示弹窗，点击空白处或确认按钮关闭
- keyPress: Escape
- aiAct: 持续按 Escape 或点击关闭，直到回到游戏主界面

## Known Issues

- 成就分类较多，优先处理带红点的分类，不要遍历没有红点的分类。
- 领取一个成就后列表可能滚动或重排，需要重新观察当前列表。
- 云游戏平台侧边栏不是游戏 UI，不要点击最左侧边缘图标。

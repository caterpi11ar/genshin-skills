/**
 * All prompt templates used by the vision model.
 * Pure functions — no side effects, no dependencies.
 */

import type { RecentAction } from "./types.js";

export function findCoordinatesPrompt(goal: string): string {
  return [
    `我的目标是：${goal}`,
    `请分析这张截图，找到我应该点击的交互元素（如按钮、链接、图标等），`,
    `返回该元素中心点的像素坐标，格式为纯 JSON: {"x": <number>, "y": <number>}。`,
    `如果截图中没有可以完成该目标的交互元素，返回 {"x": -1, "y": -1}。`,
    `只返回 JSON，不要任何其他文字或 markdown。`,
  ].join("");
}

export function checkConditionPrompt(condition: string): string {
  return `查看这张截图，判断以下条件是否成立："${condition}"。只回答 true 或 false，不要其他文字。`;
}

export function planNextActionPrompt(
  goal: string,
  recentActions?: RecentAction[],
): string {
  const parts = [
    `你正在帮我完成以下任务：${goal}\n\n`,
    `请分析这张截图，判断当前状态，并决定下一步操作。\n\n`,
    `【画面信息】\n`,
    `- 视口分辨率：1280×720 像素（坐标范围 x: 0-1279, y: 0-719）\n`,
    `- 截图与视口像素一一对应，你返回的坐标将直接用于鼠标点击\n\n`,
    `【重要约束】\n`,
    `- 如果页面正在排队、加载、连接中，必须选择 "wait" 等待，绝对不要点击「退出排队」「取消排队」「取消」「退出」等中断按钮。\n`,
    `- 如果页面显示排队进度（如「排队中」「前方X人」「预计等待」），这是正常流程，耐心等待即可。\n`,
    `- 只有在明确需要推进任务时才点击，不确定时优先选择 "wait"。\n\n`,
    `【坐标精度要求】\n`,
    `- 你必须返回目标元素的精确中心点坐标，不是弹窗的中心，而是你想点击的那个具体按钮/图标的中心。\n`,
    `- 关闭按钮（×）通常是 15-25 像素的小图标，紧贴弹窗矩形右上角。先目测弹窗的右边界和上边界，关闭按钮就在那个角上。\n`,
    `- 例：如果弹窗右边界 x≈770、上边界 y≈230，则关闭按钮约在 (760, 240) 附近，而不是弹窗中心 (607, 343)。\n`,
    `- 对于普通按钮，坐标应在按钮文字的正中心。\n\n`,
    `【弹窗处理策略】\n`,
    `如果截图中出现弹窗/对话框/引导窗口：\n`,
    `1. 首先精确定位关闭按钮（×）——它在弹窗矩形右上角，通常距弹窗边框 5-15 像素内\n`,
    `2. 如果找不到关闭按钮，尝试点击弹窗内的确认/知道了/已了解按钮\n`,
    `3. 如果都不行，按 Escape 键：{"action": "press-key", "key": "Escape"}\n`,
    `4. 如果 Escape 无效，点击弹窗外部的空白区域（如屏幕角落 (10, 10) 或 (1270, 10)）\n`,
    `5. 绝对不要反复点击弹窗内容区域的中心——那里通常没有可交互元素\n\n`,
  ];

  // Inject recent action history so the model can self-correct
  if (recentActions && recentActions.length > 0) {
    parts.push(`【最近操作记录】（最近 ${recentActions.length} 步）\n`);
    for (const a of recentActions) {
      if (a.action === "click") {
        parts.push(`  步骤${a.step}: click (${a.x}, ${a.y}) — ${a.reason}\n`);
      } else if (a.action === "press-key") {
        parts.push(`  步骤${a.step}: press-key "${a.key}" — ${a.reason}\n`);
      } else {
        parts.push(`  步骤${a.step}: ${a.action} — ${a.reason}\n`);
      }
    }

    // Detect repeated clicks at similar coordinates
    const clicks = recentActions.filter(
      (a) => a.action === "click" && a.x != null && a.y != null,
    );
    if (clicks.length >= 3) {
      const last = clicks[clicks.length - 1]!;
      const allNear = clicks.every(
        (c) => Math.abs(c.x! - last.x!) <= 30 && Math.abs(c.y! - last.y!) <= 30,
      );
      if (allNear) {
        parts.push(
          `\n⚠️ 【警告：重复点击同一位置！】\n`,
          `你已经连续 ${clicks.length} 次点击坐标 (${last.x}, ${last.y}) 附近，但页面毫无变化。\n`,
          `说明这个坐标不是可交互元素（很可能是弹窗的内容区域而非按钮）。\n`,
          `你现在必须选择一个完全不同的操作：\n`,
          `- 仔细重新观察弹窗边框，精确定位右上角关闭按钮（坐标应与 (${last.x}, ${last.y}) 差距很大）\n`,
          `- 或按 Escape 键：{"action": "press-key", "key": "Escape", "reason": "..."}\n`,
          `- 或点击弹窗外部空白区域（如角落 (10, 10)）\n`,
          `- 禁止再次返回 (${last.x}, ${last.y}) 附近的坐标！\n\n`,
        );
      }
    }
  }

  parts.push(
    `返回以下格式之一：\n\n`,
    `- 点击元素：{"action": "click", "x": <number>, "y": <number>, "reason": "..."}\n`,
    `- 等待加载：{"action": "wait", "reason": "..."}\n`,
    `- 滚动页面：{"action": "scroll", "direction": "up" | "down", "reason": "..."}\n`,
    `- 输入文字：{"action": "type", "text": "...", "reason": "..."}\n`,
    `- 按下按键：{"action": "press-key", "key": "Escape" | "Enter" | ..., "reason": "..."}\n`,
    `- 任务完成：{"action": "done", "success": true/false, "reason": "..."}\n\n`,
    `只返回 JSON，不要其他文字。`,
  );

  return parts.join("");
}

export function queryPrompt(prompt: string): string {
  return `${prompt}\n\n只返回纯 JSON，不要任何其他文字或 markdown。`;
}

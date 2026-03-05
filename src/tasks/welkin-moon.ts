import type { TaskDefinition, TaskResult, TaskContext } from "./base-task.js";
import { runAgentLoop } from "../agent/agent-loop.js";

/**
 * Welkin Moon daily reward claim task.
 *
 * Thin wrapper: defines the goal and delegates to the agent loop.
 */
export const welkinMoon: TaskDefinition = {
  id: "welkin-moon",
  name: "Welkin Moon Daily Claim",
  description:
    "Log in to Genshin cloud gaming, start the game, and claim the Welkin Moon daily reward.",
  defaultEnabled: true,
  timeoutMs: 300_000, // 5 minutes
  retries: 1,

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { page, model, logger, transcript, screenshotDir } = ctx;
    const start = Date.now();

    const goal =
      "在原神云游戏网页中，启动游戏并领取月卡（空月祝福）每日奖励。" +
      "过程中如果遇到弹窗（公告、用户协议、引导等），请关闭或确认它们。" +
      "如果需要激活画布或跳过加载画面，请点击屏幕。" +
      "【禁止操作】绝对不要点击「退出排队」「取消排队」或任何会中断排队/加载的按钮。" +
      "排队是启动游戏的正常流程，必须耐心等待排队完成。" +
      "成功领取奖励或确认奖励已被领取后，任务即完成。";

    try {
      const result = await runAgentLoop({
        page,
        model,
        goal,
        timeoutMs: this.timeoutMs,
        transcript,
        screenshotDir: screenshotDir ?? "./tmp",
      });

      return {
        taskId: "welkin-moon",
        success: result.success,
        message: result.reason,
        durationMs: result.durationMs,
        screenshot: result.screenshotPaths[result.screenshotPaths.length - 1],
        completedAt: new Date(),
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`[welkin-moon] Error: ${error.message}`);

      return {
        taskId: "welkin-moon",
        success: false,
        message: error.message,
        durationMs: Date.now() - start,
        completedAt: new Date(),
        error: { name: error.name, message: error.message },
      };
    }
  },
};

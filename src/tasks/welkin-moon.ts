import type { TaskDefinition, TaskResult, TaskContext } from "./base-task.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import type { TaskDescription } from "../model/types.js";

const taskDescription: TaskDescription = {
  background:
    "你正在原神云游戏网页上操作。页面有游戏画布和各种 UI 覆盖层。" +
    "这是云游戏平台，启动游戏前可能需要排队等待。",
  goal:
    "启动游戏并领取月卡（空月祝福）每日奖励。" +
    "成功领取奖励或确认已领取后，任务完成。",
  knownIssues: [
    "「保存网页地址」引导弹窗——关闭按钮（×）在弹窗矩形右上角，" +
      "是小图标，不是弹窗中心。多次点击无效请按 Escape。",
    "排队画面（显示「排队中」「前方X人」）——正常流程，选择 wait 等待，" +
      "绝不点击「退出排队」「取消排队」。",
    "用户协议/公告弹窗——点击「同意」「确认」「我知道了」按钮。",
    "画布未激活——点击画面中央激活。",
    "加载画面——选择 wait，不要点击。",
  ],
};

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
  timeoutMs: 600_000, // 10 minutes (pro models are slower per step)
  retries: 1,

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { page, model, logger, transcript, screenshotDir } = ctx;
    const start = Date.now();

    try {
      const result = await runAgentLoop({
        page,
        model,
        goal: taskDescription,
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

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/schema.js";
import type { RunSummary } from "../memory/types.js";
import type { GatewaySnapshot, IGateway } from "./types.js";
import { GatewayState } from "./state.js";
import { Scheduler } from "./scheduler.js";
import { TaskQueue } from "../queue/task-queue.js";
import { TaskRunner, type RunResult } from "../tasks/task-runner.js";
import { allTasks } from "../tasks/index.js";
import { SessionManager } from "../browser/session-manager.js";
import { loginFlow } from "../browser/login.js";
import { VisionModel } from "../model/vision-model.js";
import { TranscriptWriter } from "../memory/transcript.js";
import { StateStore } from "../memory/state-store.js";
import { logger } from "../utils/logger.js";

export class Gateway implements IGateway {
  readonly state: GatewayState;
  readonly config: AppConfig;

  private queue: TaskQueue;
  private taskRunner: TaskRunner;
  private scheduler: Scheduler | null = null;
  private stateStore: StateStore;

  constructor(config: AppConfig) {
    this.config = config;
    this.state = new GatewayState();
    this.queue = new TaskQueue();
    this.taskRunner = new TaskRunner();
    this.taskRunner.registerAll(allTasks);
    this.stateStore = new StateStore();

    // Forward task runner events to gateway state
    this.taskRunner.on("task:start", (data: { taskId: string }) => {
      this.state.update({ currentTask: data.taskId });
    });
    this.taskRunner.on("task:complete", () => {
      this.state.update({ currentTask: null });
    });

    // Keep queue depth in sync
    this.queue.on("enqueue", () => {
      this.state.update({ queueDepth: this.queue.getDepth() });
    });
    this.queue.on("complete", () => {
      this.state.update({ queueDepth: this.queue.getDepth() });
    });
    this.queue.on("error", () => {
      this.state.update({ queueDepth: this.queue.getDepth() });
    });
  }

  getSnapshot(): GatewaySnapshot {
    return this.state.getSnapshot();
  }

  getTaskRunner(): TaskRunner {
    return this.taskRunner;
  }

  /**
   * Enqueue a run through the FIFO queue. Returns when the run completes.
   */
  async enqueueRun(
    trigger: "cron" | "manual" | "api",
    taskIds?: string[],
  ): Promise<RunResult> {
    const runId = randomUUID();
    const item = { runId, trigger, taskIds, enqueuedAt: new Date() };

    return this.queue.enqueue(item, () =>
      this.executePipeline(runId, trigger, taskIds),
    );
  }

  /**
   * Run once without going through the queue (for CLI `run` command).
   */
  async runOnce(taskIds?: string[]): Promise<RunResult> {
    const runId = randomUUID();
    return this.executePipeline(runId, "manual", taskIds);
  }

  async getRunHistory(limit?: number): Promise<RunSummary[]> {
    return this.stateStore.getHistory(limit);
  }

  /**
   * Start daemon mode: scheduler + optional web + optional TUI.
   */
  async start(): Promise<void> {
    // Start scheduler
    this.scheduler = new Scheduler({
      cronExpr: this.config.schedule.cron,
      timezone: this.config.schedule.timezone,
      onTick: () => {
        logger.info("Cron triggered — starting task run");
        this.enqueueRun("cron").catch((err) => {
          logger.error("Cron run failed", err);
        });
      },
    });
    this.scheduler.start();

    logger.info("Gateway started in daemon mode");
  }

  async shutdown(): Promise<void> {
    logger.info("Gateway shutting down");
    if (this.scheduler) {
      this.scheduler.stop();
    }
    await this.queue.drain();
    logger.info("Gateway shutdown complete");
  }

  /**
   * Core execution pipeline: launch browser → login → run tasks → persist.
   */
  private async executePipeline(
    runId: string,
    trigger: "cron" | "manual" | "api",
    taskIds?: string[],
  ): Promise<RunResult> {
    this.state.update({ running: true, currentRunId: runId });
    this.state.emit("run:start", runId, trigger);

    const session = new SessionManager(this.config);
    const transcript = new TranscriptWriter(runId);

    try {
      await loginFlow(session, this.config);

      const page = session.getPage();
      const model = new VisionModel({
        ...this.config.model,
        viewport: this.config.browser.viewport,
      });
      const enabledIds = taskIds ?? this.config.tasks.enabled;

      const result = await this.taskRunner.runAll(
        { page, model, config: this.config, transcript, screenshotDir: "./tmp" },
        enabledIds,
      );

      // Persist
      const summary: RunSummary = {
        runId,
        trigger,
        startedAt: result.startedAt.toISOString(),
        completedAt: result.completedAt.toISOString(),
        results: result.results.map((r) => ({
          taskId: r.taskId,
          success: r.success,
          message: r.message,
          durationMs: r.durationMs,
        })),
      };
      await this.stateStore.updateAfterRun(summary);

      this.state.update({
        running: false,
        currentRunId: null,
        currentTask: null,
        lastRunAt: result.completedAt.toISOString(),
        lastSuccess: result.results.every((r) => r.success),
      });
      this.state.emit("run:complete", runId, result);

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Run ${runId} failed`, error);
      this.state.update({
        running: false,
        currentRunId: null,
        currentTask: null,
      });
      this.state.emit("run:error", runId, error);
      throw error;
    } finally {
      await session.close();
    }
  }
}

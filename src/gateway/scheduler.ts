import type { ScheduledTask } from 'node-cron'
import cron from 'node-cron'
import { logger } from '../utils/logger.js'

export interface SchedulerOptions {
  cronExpr: string
  timezone: string
  onTick: () => void
}

/**
 * Thin wrapper around node-cron.
 */
export class Scheduler {
  private job: ScheduledTask | null = null
  private stopPromise: Promise<void> | null = null
  private cronExpr: string
  private timezone: string
  private onTick: () => void

  constructor(options: SchedulerOptions) {
    this.cronExpr = options.cronExpr
    this.timezone = options.timezone
    this.onTick = options.onTick
  }

  start(): void {
    if (this.job)
      return
    logger.info(
      `Scheduler starting — cron: "${this.cronExpr}" (${this.timezone})`,
    )
    this.job = cron.schedule(this.cronExpr, this.onTick, {
      timezone: this.timezone,
    })
  }

  stop(): Promise<void> {
    if (this.stopPromise)
      return this.stopPromise
    if (!this.job)
      return Promise.resolve()

    const job = this.job
    const operation = Promise.resolve()
      .then(() => job.stop())
      .then(() => {
        if (this.job === job)
          this.job = null
        logger.info('Scheduler stopped')
      })
    const tracked = operation.finally(() => {
      if (this.stopPromise === tracked)
        this.stopPromise = null
    })
    this.stopPromise = tracked
    return tracked
  }

  getCronExpr(): string {
    return this.cronExpr
  }

  getTimezone(): string {
    return this.timezone
  }
}

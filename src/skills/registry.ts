import type { TaskContext, TaskDefinition, TaskResult } from '../tasks/base-task.js'
import type { SkillDefinition } from './types.js'
import { executeSteps } from '../agent/step-executor.js'
import { PATHS } from '../config/paths.js'
import { loadSkills } from './loader.js'

export class SkillRegistry {
  private skills: SkillDefinition[] = []

  async loadFromDirs(dirs: string[]): Promise<void> {
    this.skills = await loadSkills(dirs)
  }

  getAll(): SkillDefinition[] {
    return this.skills
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.find(s => s.id === id)
  }

  toTaskDefinitions(): TaskDefinition[] {
    return this.skills
      .filter(skill => skill.enabled)
      .map(skill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        defaultEnabled: skill.enabled,
        timeoutMs: skill.timeoutMs,
        retries: skill.retries,

        async execute(ctx: TaskContext): Promise<TaskResult> {
          const start = Date.now()

          try {
            const result = await executeSteps({
              page: ctx.page,
              steps: skill.steps,
              modelConfig: ctx.modelConfig,
              timeoutMs: skill.timeoutMs,
              transcript: ctx.transcript,
              screenshotDir: ctx.screenshotDir ?? PATHS.screenshotDir,
              onProgress: ctx.onProgress,
            })

            return {
              taskId: skill.id,
              success: result.success,
              message: result.reason,
              durationMs: result.durationMs,
              completedAt: new Date(),
            }
          }
          catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            ctx.logger.error(`[${skill.id}] Error: ${error.message}`)

            return {
              taskId: skill.id,
              success: false,
              message: error.message,
              durationMs: Date.now() - start,
              completedAt: new Date(),
              error: { name: error.name, message: error.message },
            }
          }
        },
      }))
  }
}

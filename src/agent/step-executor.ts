import type { AgentResult, StepContext } from './types.js'
import process from 'node:process'
import { PlaywrightAgent } from '@midscene/web/playwright'
import { logger } from '../utils/logger.js'

/**
 * Execute structured skill steps using Midscene PlaywrightAgent.
 * Each step maps to a PlaywrightAgent method (aiAct, aiTap, aiWaitFor, etc.).
 * Midscene internally handles screenshot → vision model → coordinate resolution.
 */
export async function executeSteps(ctx: StepContext): Promise<AgentResult> {
  const { page, steps, modelConfig, timeoutMs, transcript, onProgress } = ctx

  // Set midscene model config via environment variables
  for (const [key, value] of Object.entries(modelConfig)) {
    if (value) {
      process.env[key] = value
    }
  }

  // Extend Playwright screenshot timeout for game pages.
  // Midscene hardcodes timeout: 10000 in its screenshotBase64() call,
  // but cloud gaming pages with WebGL canvas and heavy web fonts can
  // block "waiting for fonts to load" indefinitely. Override to 60s.
  const origScreenshot = page.screenshot.bind(page)
  page.screenshot = (options?: Record<string, unknown>) =>
    origScreenshot({ ...options, timeout: 60_000 })

  const agent = new PlaywrightAgent(page)
  const start = Date.now()

  for (let i = 0; i < steps.length; i++) {
    if (Date.now() - start > timeoutMs) {
      return {
        success: false,
        reason: `Timed out at step ${i + 1}/${steps.length}`,
        steps: i,
        durationMs: Date.now() - start,
      }
    }

    const step = steps[i]!
    logger.info(`Step ${i + 1}/${steps.length}: ${step.method}("${step.prompt}")`)
    onProgress?.(i + 1, Date.now() - start, step.method, step.prompt)

    try {
      // Calculate remaining time for this step
      const remaining = timeoutMs - (Date.now() - start)

      switch (step.method) {
        case 'aiAct':
          await agent.aiAction(step.prompt)
          break
        case 'aiTap':
          await agent.aiTap(step.prompt)
          break
        case 'aiWaitFor':
          // Use remaining time as timeout, check every 15s to reduce API calls
          await agent.aiWaitFor(step.prompt, {
            timeoutMs: Math.min(remaining, 180_000),
            checkIntervalMs: 15_000,
          })
          break
        case 'aiAssert':
          await agent.aiAssert(step.prompt)
          break
        case 'aiBoolean':
          await agent.aiBoolean(step.prompt)
          break
        case 'keyPress':
          await page.keyboard.press(step.prompt)
          break
      }
    }
    catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      logger.error(`Step ${i + 1} failed: ${error.message}`)

      if (transcript) {
        await transcript.append({
          step: i + 1,
          timestamp: new Date().toISOString(),
          method: step.method,
          prompt: step.prompt,
          result: 'error',
          errorMessage: error.message,
        })
      }

      throw err
    }

    if (transcript) {
      await transcript.append({
        step: i + 1,
        timestamp: new Date().toISOString(),
        method: step.method,
        prompt: step.prompt,
        result: 'executed',
      })
    }
  }

  return {
    success: true,
    reason: 'All steps completed',
    steps: steps.length,
    durationMs: Date.now() - start,
  }
}

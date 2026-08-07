import type { Page } from 'playwright'
import type { AgentResult, StepContext } from './types.js'
import { PlaywrightAgent } from '@midscene/web/playwright'
import {
  parseArrowArgs,
  parseCoordinates,
  parseDuration,
  parseMouseButton,
  parseScrollSpec,
} from '../skills/step-arguments.js'
import { saveScreenshot } from '../tools/screenshot.js'
import { delay } from '../utils/delay.js'
import { StepExecutionError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { createStreamingOpenAIClient } from './streaming-openai-client.js'

const patchedScreenshotPages = new WeakSet<Page>()
const CLOUD_MOUSE_HOLD_MS = 100
const CLOUD_KEY_HOLD_MS = 500

function safeLabel(value: string): string {
  const sanitized = value.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
  return sanitized || 'checkpoint'
}

function buildAIContext(ctx: StepContext): string | undefined {
  const sections: string[] = []
  if (ctx.background)
    sections.push(`场景背景：\n${ctx.background}`)
  if (ctx.goal)
    sections.push(`任务目标：\n${ctx.goal}`)
  if (ctx.knownIssues?.length)
    sections.push(`已知问题与处理规则：\n${ctx.knownIssues.map(issue => `- ${issue}`).join('\n')}`)
  return sections.length > 0 ? sections.join('\n\n') : undefined
}

function ensureLongScreenshotTimeout(page: Page): void {
  if (patchedScreenshotPages.has(page))
    return

  // Midscene uses a 10s screenshot timeout internally. Cloud-game canvases
  // can legitimately need longer while WebGL and fonts are loading.
  const originalScreenshot = page.screenshot.bind(page)
  page.screenshot = (options?: Record<string, unknown>) =>
    originalScreenshot({ ...options, timeout: 60_000 })

  // Cloud-game clients sample input on render frames. Playwright's default
  // zero-duration key presses and mouse clicks can be dropped or interpreted
  // as focus-only events, so keep them down long enough to cross a frame.
  const originalMouseClick = page.mouse.click.bind(page.mouse)
  page.mouse.click = (x, y, options) => originalMouseClick(x, y, {
    ...options,
    delay: Math.max(options?.delay ?? 0, CLOUD_MOUSE_HOLD_MS),
  })

  const originalKeyboardUp = page.keyboard.up.bind(page.keyboard)
  page.keyboard.up = async (key) => {
    await delay(CLOUD_KEY_HOLD_MS)
    return originalKeyboardUp(key)
  }
  patchedScreenshotPages.add(page)
}

function assertPointInViewport(page: Page, point: [number, number]): void {
  const viewport = page.viewportSize()
  if (!viewport)
    return
  const [x, y] = point
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
    throw new Error(
      `Coordinates ${x},${y} are outside the ${viewport.width}x${viewport.height} viewport`,
    )
  }
}

/**
 * Execute a validated skill workflow.
 *
 * AI-prefixed methods use Midscene vision. The remaining methods are exact
 * Playwright keyboard/mouse operations, which makes recorded macro-style
 * routines possible without spending a model call on every action.
 */
export async function executeSteps(ctx: StepContext): Promise<AgentResult> {
  const {
    skillId,
    page,
    steps,
    modelConfig,
    timeoutMs,
    transcript,
    screenshotDir,
    onProgress,
  } = ctx

  ensureLongScreenshotTimeout(page)
  const agent = new PlaywrightAgent(page, {
    groupName: skillId,
    groupDescription: ctx.goal ?? ctx.background,
    aiActionContext: buildAIContext(ctx),
    modelConfig,
    replanningCycleLimit: ctx.replanningCycleLimit,
    ...(ctx.streamModelResponses
      ? { createOpenAIClient: async (client: unknown) => createStreamingOpenAIClient(client) }
      : {}),
  })
  const start = Date.now()

  try {
    for (let i = 0; i < steps.length; i++) {
      const elapsed = Date.now() - start
      if (elapsed > timeoutMs) {
        return {
          success: false,
          reason: `Timed out at step ${i + 1}/${steps.length}`,
          steps: i,
          durationMs: elapsed,
        }
      }

      const step = steps[i]!
      logger.info(`Step ${i + 1}/${steps.length}: ${step.method}("${step.prompt}")`)
      onProgress?.(i + 1, elapsed, step.method, step.prompt)

      let output: string | number | boolean | undefined
      let checkpointPath: string | undefined
      try {
        const remaining = timeoutMs - (Date.now() - start)

        switch (step.method) {
          case 'aiAct':
            await agent.aiAction(step.prompt)
            break
          case 'aiTap':
            await agent.aiTap(step.prompt)
            break
          case 'aiRightClick':
            await agent.aiRightClick(step.prompt)
            break
          case 'aiHover':
            await agent.aiHover(step.prompt)
            break
          case 'aiInput': {
            const [value, target] = parseArrowArgs(step.prompt, step.method)
            await agent.aiInput(value, target!)
            break
          }
          case 'aiKeyboardPress': {
            const [key, target] = parseArrowArgs(step.prompt, step.method, true)
            await agent.aiKeyboardPress(key, target)
            break
          }
          case 'aiScroll': {
            const [spec, target] = parseArrowArgs(step.prompt, step.method, true)
            const { direction, distance } = parseScrollSpec(spec, step.method)
            await agent.aiScroll({
              direction,
              scrollType: 'once',
              distance,
            }, target)
            break
          }
          case 'aiWaitFor':
            await agent.aiWaitFor(step.prompt, {
              timeoutMs: Math.max(1, remaining),
              checkIntervalMs: 15_000,
            })
            break
          case 'aiAssert':
            await agent.aiAssert(step.prompt)
            break
          case 'aiBoolean':
            output = await agent.aiBoolean(step.prompt)
            break
          case 'click': {
            const point = parseCoordinates(step.prompt)
            assertPointInViewport(page, point)
            await page.mouse.click(...point)
            break
          }
          case 'rightClick': {
            const point = parseCoordinates(step.prompt)
            assertPointInViewport(page, point)
            await page.mouse.click(...point, { button: 'right' })
            break
          }
          case 'move': {
            const point = parseCoordinates(step.prompt)
            assertPointInViewport(page, point)
            await page.mouse.move(...point)
            break
          }
          case 'scroll': {
            const spec = parseScrollSpec(step.prompt, step.method)
            const { direction } = spec
            const distance = spec.distance ?? 500
            const dx = direction === 'left' ? -distance : direction === 'right' ? distance : 0
            const dy = direction === 'up' ? -distance : direction === 'down' ? distance : 0
            await page.mouse.wheel(dx, dy)
            break
          }
          case 'type':
            await page.keyboard.type(step.prompt)
            break
          case 'keyPress':
            await page.keyboard.press(step.prompt)
            break
          case 'keyDown':
            await page.keyboard.down(step.prompt)
            break
          case 'keyUp':
            await page.keyboard.up(step.prompt)
            break
          case 'mouseDown':
            await page.mouse.down({ button: parseMouseButton(step.prompt) })
            break
          case 'mouseUp':
            await page.mouse.up({ button: parseMouseButton(step.prompt) })
            break
          case 'wait': {
            const durationMs = parseDuration(step.prompt)
            if (durationMs > remaining)
              throw new Error(`Wait of ${durationMs}ms exceeds the task's remaining ${remaining}ms`)
            await delay(durationMs)
            break
          }
          case 'screenshot':
            if (!screenshotDir)
              throw new Error('No screenshot directory configured')
            checkpointPath = await saveScreenshot(
              page,
              screenshotDir,
              `${safeLabel(skillId)}-step-${i + 1}-${safeLabel(step.prompt)}`,
            )
            output = checkpointPath
            break
          default: {
            const exhaustive: never = step.method
            throw new Error(`Unsupported step method: ${exhaustive}`)
          }
        }
      }
      catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        logger.error(`Step ${i + 1} failed: ${error.message}`)

        let failureScreenshot: string | undefined
        if (screenshotDir) {
          try {
            failureScreenshot = await saveScreenshot(
              page,
              screenshotDir,
              `${safeLabel(skillId)}-step-${i + 1}-failure`,
            )
          }
          catch (screenshotError) {
            logger.warn('Could not capture failure screenshot', screenshotError)
          }
        }

        await transcript?.append({
          step: i + 1,
          timestamp: new Date().toISOString(),
          method: step.method,
          prompt: step.prompt,
          result: 'error',
          errorMessage: error.message,
          screenshotPath: failureScreenshot,
        })

        throw new StepExecutionError(
          `Step ${i + 1}/${steps.length} (${step.method}) failed: ${error.message}`,
          i + 1,
          failureScreenshot,
          error,
        )
      }

      await transcript?.append({
        step: i + 1,
        timestamp: new Date().toISOString(),
        method: step.method,
        prompt: step.prompt,
        result: 'executed',
        screenshotPath: checkpointPath,
        output,
      })
    }

    return {
      success: true,
      reason: 'All steps completed',
      steps: steps.length,
      durationMs: Date.now() - start,
    }
  }
  finally {
    try {
      await agent.destroy()
    }
    catch (err) {
      logger.warn('Could not cleanly destroy Midscene agent', err)
    }
  }
}

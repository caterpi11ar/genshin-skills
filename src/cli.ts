import type { ProgressEvent } from './utils/progress.js'
import process from 'node:process'
import { Command } from 'commander'
import ora from 'ora'
import { loadConfig } from './config/loader.js'
import { initStateDir, PATHS } from './config/paths.js'
import { Gateway } from './gateway/gateway.js'
import { startGateway } from './gateway/lifecycle.js'
import { STEP_METHODS } from './skills/types.js'
import { logger } from './utils/logger.js'

const program = new Command()

program
  .name('giclaw')
  .description('AI agent for Genshin Impact cloud gaming')
  .version('0.3.0')
  .option('-c, --config <path>', 'config file path')
  .option('-t, --tasks <ids...>', 'task IDs to run')
  .option('-r, --routine <name>', 'named routine to run')
  .option('--headless', 'force headless mode')
  .option('--no-headless', 'force visible mode')
  .option('--dry-run', 'validate config only, do not execute')
  .option('-v, --verbose', 'enable debug logging')

program
  .command('run', { isDefault: true })
  .description('Run tasks once (default)')
  .action(async () => {
    const opts = program.opts()
    await runOnce(opts)
  })

program
  .command('skills')
  .description('List validated skills, routines, and atomic operations')
  .action(async () => {
    const opts = program.opts()
    const config = await loadConfig({ configPath: opts.config as string | undefined })
    const gateway = new Gateway(config)
    await gateway.init()

    logger.info('Atomic operations:')
    logger.info(`  ${STEP_METHODS.join(', ')}`)
    logger.info('Skills:')
    for (const skill of gateway.getSkillSummaries()) {
      const dependencies = skill.dependsOn.length ? `; depends on ${skill.dependsOn.join(', ')}` : ''
      logger.info(`  ${skill.id} — ${skill.steps} step(s)${dependencies}`)
    }
    logger.info('Routines:')
    for (const [name, ids] of Object.entries(config.tasks.routines))
      logger.info(`  ${name}: ${ids.join(' -> ')}`)
  })

program
  .command('daemon')
  .description('Run as daemon with cron scheduling')
  .option('-p, --port <number>', 'web panel port', '3000')
  .option('--no-web', 'disable web panel')
  .action(async (daemonOpts) => {
    const opts = program.opts()
    await runDaemon(opts, daemonOpts)
  })

program
  .command('init')
  .description('Initialize ~/.giclaw/ with interactive setup')
  .option('--non-interactive', 'skip interactive prompts, create defaults only')
  .action(async (initOpts) => {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY
    const nonInteractive = initOpts.nonInteractive || !isTTY

    if (nonInteractive) {
      // Original non-interactive logic
      const { created } = await initStateDir()
      if (created.length === 0) {
        logger.info(`~/.giclaw/ already initialized at ${PATHS.stateDir}`)
      }
      else {
        logger.info(`Initialized ~/.giclaw/ at ${PATHS.stateDir}`)
        for (const f of created) {
          logger.info(`  Created ${f}`)
        }
      }
      return
    }

    // Interactive mode
    const { isModelConfigured, runSetupWizard } = await import(
      './config/wizard.js',
    )

    if (await isModelConfigured()) {
      const { confirm } = await import('@inquirer/prompts')
      const redo = await confirm({
        message:
          'Model is already configured. Do you want to reconfigure?',
        default: false,
      })
      if (!redo) {
        logger.info('No changes made.')
        return
      }
    }

    await runSetupWizard()
  })

program
  .command('config')
  .description('Show resolved config paths')
  .action(() => {
    for (const [key, value] of Object.entries(PATHS)) {
      logger.info(`${key}: ${value}`)
    }
  })

function isModelConfigured(config: Awaited<ReturnType<typeof loadConfig>>): boolean {
  return Boolean(config.model.apiKey && config.model.baseUrl && config.model.name)
}

async function runOnce(opts: Record<string, unknown>): Promise<void> {
  const cliOverrides: Record<string, unknown> = {}
  if (opts.headless !== undefined) {
    cliOverrides.browser = { headless: opts.headless as boolean }
  }

  let config = await loadConfig({
    configPath: opts.config as string | undefined,
    cliOverrides,
  })

  // Config check — prompt setup wizard if the resolved config is not configured.
  if (!isModelConfigured(config)) {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY
    if (isTTY && !opts.config) {
      logger.warn(
        'Model not configured. Starting setup wizard...',
      )
      const { runSetupWizard } = await import('./config/wizard.js')
      await runSetupWizard()
      config = await loadConfig({ cliOverrides })
      if (!isModelConfigured(config)) {
        logger.error('Model still not configured. Aborting.')
        process.exitCode = 1
        return
      }
    }
    else {
      logger.error(
        opts.config
          ? `Model not configured in ${String(opts.config)}.`
          : 'Model not configured. Run `giclaw init` to set up your API key and model.',
      )
      process.exitCode = 1
      return
    }
  }

  logger.setLevel(config.logLevel)
  if (opts.verbose) {
    logger.setLevel('debug')
  }

  const gateway = new Gateway(config)
  await gateway.init()
  const requestedTasks = opts.tasks as string[] | undefined
  const routineName = opts.routine as string | undefined
  if (requestedTasks && routineName) {
    logger.error('Use either --tasks or --routine, not both.')
    process.exitCode = 1
    return
  }
  if (routineName && !config.tasks.routines[routineName]) {
    logger.error(`Unknown routine "${routineName}". Available: ${Object.keys(config.tasks.routines).join(', ')}`)
    process.exitCode = 1
    return
  }
  const taskIds = requestedTasks ?? (routineName ? config.tasks.routines[routineName] : undefined)
  // Resolve once up front to validate explicit CLI selections and show the
  // dependency-expanded order in dry-run mode.
  const resolvedTasks = gateway.getTaskRunner().getEnabledTasks(taskIds ?? config.tasks.enabled)

  if (opts.dryRun) {
    logger.info('Dry run — config and skills validated successfully.')
    logger.info(`Execution order: ${resolvedTasks.map(task => task.id).join(' -> ')}`)
    logger.info(`Atomic operations available: ${STEP_METHODS.length}`)
    logger.info('No browser was launched and no model API request was made.')
    return
  }

  // Real-time progress in TTY mode
  const isTTY = process.stderr.isTTY
  let progressCleanup: (() => void) | undefined

  if (isTTY) {
    const formatElapsed = (ms: number): string => {
      const sec = Math.floor(ms / 1000)
      if (sec < 60)
        return `${sec}s`
      const min = Math.floor(sec / 60)
      const s = sec % 60
      return `${min}m ${s.toString().padStart(2, '0')}s`
    }

    const spinner = ora({ stream: process.stderr }).start('Starting...')

    const onProgress = (event: ProgressEvent) => {
      let text = `[${formatElapsed(event.elapsed)}]`
      if (event.phase === 'login') {
        text += ' Logging in...'
      }
      else if (event.phase === 'running') {
        if (event.taskTotal > 0) {
          text += ` Task ${event.taskIndex}/${event.taskTotal}: ${event.taskId ?? ''}`
        }
        if (event.step > 0) {
          text += ` | Step ${event.step}: ${event.action ?? ''}`
        }
        if (event.reason) {
          text += ` — "${event.reason}"`
        }
      }
      else if (event.phase === 'done') {
        text += ' Done'
      }
      else if (event.phase === 'error') {
        text += ` Error: ${event.reason ?? 'unknown'}`
      }
      spinner.text = text
    }

    logger.on('progress', onProgress)
    logger.mute()
    progressCleanup = () => {
      logger.off('progress', onProgress)
      logger.unmute()
      spinner.stop()
    }
  }

  try {
    const result = await gateway.runOnce(taskIds)
    progressCleanup?.()

    for (const r of result.results) {
      const status = r.success ? 'OK' : 'FAIL'
      logger.info(
        `  [${status}] ${r.taskId}: ${r.message} (${r.durationMs}ms)`,
      )
    }

    const failed = result.results.filter(r => !r.success)
    if (failed.length > 0) {
      process.exitCode = 1
    }
  }
  catch (err) {
    progressCleanup?.()
    logger.error('Run failed', err)
    process.exitCode = 1
  }
}

async function runDaemon(
  opts: Record<string, unknown>,
  daemonOpts: Record<string, unknown>,
): Promise<void> {
  const cliOverrides: Record<string, unknown> = {}
  if (opts.headless !== undefined) {
    cliOverrides.browser = { headless: opts.headless as boolean }
  }

  const webPort = Number(daemonOpts.port ?? 3000)
  const webEnabled = daemonOpts.web !== false
  cliOverrides.web = { port: webPort, enabled: webEnabled }

  const config = await loadConfig({
    configPath: opts.config as string | undefined,
    cliOverrides,
  })

  // Daemon mode cannot run an interactive setup wizard.
  if (!isModelConfigured(config)) {
    logger.error('Model not configured. Run `giclaw init` to set up your API key and model.')
    process.exitCode = 1
    return
  }

  logger.setLevel(config.logLevel)
  if (opts.verbose) {
    logger.setLevel('debug')
  }

  await startGateway(config)
}

program.parse()

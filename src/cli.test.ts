import type { ProgressEvent } from './utils/progress.js'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const spinner = {
    text: '',
    stop: vi.fn(),
  }
  const runner = {
    getEnabledTasks: vi.fn(),
  }
  const gateway = {
    init: vi.fn(),
    getSkillSummaries: vi.fn(),
    getTaskRunner: vi.fn(() => runner),
    runOnce: vi.fn(),
  }
  return {
    loadConfig: vi.fn(),
    initStateDir: vi.fn(),
    PATHS: {
      stateDir: '/tmp/.giclaw',
      configPath: '/tmp/.giclaw/config.json',
      cookiePath: '/tmp/.giclaw/cookies.json',
      dataDir: '/tmp/.giclaw/data',
    },
    gateway,
    runner,
    Gateway: vi.fn(() => gateway),
    startGateway: vi.fn(),
    runSetupWizard: vi.fn(),
    wizardConfigured: vi.fn(),
    confirm: vi.fn(),
    spinner,
    ora: vi.fn(() => ({
      start: vi.fn(() => spinner),
    })),
    logger: {
      setLevel: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      mute: vi.fn(),
      unmute: vi.fn(),
    },
  }
})

vi.mock('./config/loader.js', () => ({ loadConfig: mocks.loadConfig }))
vi.mock('./config/paths.js', () => ({ initStateDir: mocks.initStateDir, PATHS: mocks.PATHS }))
vi.mock('./gateway/gateway.js', () => ({ Gateway: mocks.Gateway }))
vi.mock('./gateway/lifecycle.js', () => ({ startGateway: mocks.startGateway }))
vi.mock('./config/wizard.js', () => ({
  isModelConfigured: mocks.wizardConfigured,
  runSetupWizard: mocks.runSetupWizard,
}))
vi.mock('@inquirer/prompts', () => ({ confirm: mocks.confirm }))
vi.mock('./utils/logger.js', () => ({ logger: mocks.logger }))
vi.mock('ora', () => ({ default: mocks.ora }))

interface TestConfig {
  model: { name: string, baseUrl: string, apiKey: string }
  browser: { headless: boolean }
  tasks: {
    enabled: string[]
    routines: Record<string, string[]>
  }
  web: { enabled: boolean, port: number }
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

function config(overrides: Partial<TestConfig> = {}): TestConfig {
  return {
    model: { name: 'gpt-5.6', baseUrl: 'http://127.0.0.1:3002/v1', apiKey: 'test-key' },
    browser: { headless: true },
    tasks: {
      enabled: ['welkin-moon', 'claim-mail'],
      routines: { daily: ['welkin-moon', 'claim-mail'] },
    },
    web: { enabled: true, port: 3000 },
    logLevel: 'info',
    ...overrides,
  }
}

const originalArgv = process.argv
const ttyDescriptors = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
  stderr: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'),
}

function setTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): void {
  Object.defineProperty(stream, 'isTTY', { configurable: true, value })
}

async function runCli(...args: string[]): Promise<void> {
  process.argv = ['node', 'giclaw', ...args]
  vi.resetModules()
  await import('./cli.js')
}

describe('cLI', () => {
  beforeEach(() => {
    process.exitCode = undefined
    setTTY(process.stdin, false)
    setTTY(process.stdout, false)
    setTTY(process.stderr, false)
    mocks.loadConfig.mockResolvedValue(config())
    mocks.gateway.init.mockResolvedValue(undefined)
    mocks.gateway.getSkillSummaries.mockReturnValue([])
    mocks.runner.getEnabledTasks.mockImplementation((ids: string[]) => ids.map(id => ({ id })))
    mocks.gateway.runOnce.mockResolvedValue({ results: [] })
    mocks.startGateway.mockResolvedValue(undefined)
    mocks.initStateDir.mockResolvedValue({ created: [] })
    mocks.wizardConfigured.mockResolvedValue(false)
    mocks.confirm.mockResolvedValue(false)
    mocks.runSetupWizard.mockResolvedValue(undefined)
    mocks.spinner.text = ''
  })

  afterEach(() => {
    process.argv = originalArgv
    process.exitCode = undefined
    for (const [key, descriptor] of Object.entries(ttyDescriptors)) {
      if (descriptor)
        Object.defineProperty(process[key as keyof typeof ttyDescriptors], 'isTTY', descriptor)
    }
  })

  it('validates explicit tasks in dependency order during a verbose dry run', async () => {
    await runCli('--config', '/tmp/custom.json', '--tasks', 'claim-mail', '--no-headless', '--dry-run', '--verbose', 'run')

    expect(mocks.loadConfig).toHaveBeenCalledWith({
      configPath: '/tmp/custom.json',
      cliOverrides: { browser: { headless: false } },
    })
    expect(mocks.logger.setLevel).toHaveBeenCalledWith('debug')
    expect(mocks.runner.getEnabledTasks).toHaveBeenCalledWith(['claim-mail'])
    expect(mocks.logger.info).toHaveBeenCalledWith('Execution order: claim-mail')
    expect(mocks.gateway.runOnce).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('resolves a named routine in dry-run mode', async () => {
    await runCli('--routine', 'daily', '--dry-run')

    expect(mocks.runner.getEnabledTasks).toHaveBeenCalledWith(['welkin-moon', 'claim-mail'])
    expect(mocks.logger.info).toHaveBeenCalledWith('Execution order: welkin-moon -> claim-mail')
  })

  it('rejects conflicting task and routine selections', async () => {
    await runCli('--tasks', 'claim-mail', '--routine', 'daily')

    expect(mocks.logger.error).toHaveBeenCalledWith('Use either --tasks or --routine, not both.')
    expect(mocks.runner.getEnabledTasks).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('rejects an unknown routine and lists available names', async () => {
    await runCli('--routine', 'missing')

    expect(mocks.logger.error).toHaveBeenCalledWith('Unknown routine "missing". Available: daily')
    expect(process.exitCode).toBe(1)
  })

  it.each([
    [[], 'Model not configured. Run `giclaw init` to set up your API key and model.'],
    [['--config', '/tmp/empty.json'], 'Model not configured in /tmp/empty.json.'],
  ])('rejects non-interactive unconfigured runs %#', async (args, message) => {
    mocks.loadConfig.mockResolvedValue(config({
      model: { name: '', baseUrl: '', apiKey: '' },
    }))

    await runCli(...args)

    expect(mocks.logger.error).toHaveBeenCalledWith(message)
    expect(mocks.Gateway).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('runs setup interactively, reloads config, and aborts if setup remains incomplete', async () => {
    setTTY(process.stdin, true)
    setTTY(process.stdout, true)
    const incomplete = config({ model: { name: '', baseUrl: '', apiKey: '' } })
    mocks.loadConfig.mockResolvedValue(incomplete)

    await runCli()

    expect(mocks.runSetupWizard).toHaveBeenCalledOnce()
    expect(mocks.loadConfig).toHaveBeenCalledTimes(2)
    expect(mocks.logger.error).toHaveBeenCalledWith('Model still not configured. Aborting.')
    expect(process.exitCode).toBe(1)
  })

  it('continues after interactive setup produces a complete model config', async () => {
    setTTY(process.stdin, true)
    setTTY(process.stdout, true)
    const incomplete = config({ model: { name: '', baseUrl: '', apiKey: '' } })
    mocks.loadConfig.mockResolvedValueOnce(incomplete).mockResolvedValueOnce(config())

    await runCli('--dry-run')

    expect(mocks.runSetupWizard).toHaveBeenCalledOnce()
    expect(mocks.runner.getEnabledTasks).toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('renders TTY progress, reports task results, and sets failure exit status', async () => {
    setTTY(process.stderr, true)
    let progressListener: ((event: ProgressEvent) => void) | undefined
    mocks.logger.on.mockImplementation((event: string, listener: (event: ProgressEvent) => void) => {
      if (event === 'progress')
        progressListener = listener
    })
    mocks.gateway.runOnce.mockImplementation(async () => {
      progressListener?.({ phase: 'login', elapsed: 500, taskIndex: 0, taskTotal: 0, taskId: null, step: 0, action: null, reason: null, timestamp: '' })
      progressListener?.({ phase: 'running', elapsed: 65_000, taskIndex: 1, taskTotal: 2, taskId: 'claim-mail', step: 3, action: 'tap', reason: 'claim', timestamp: '' })
      progressListener?.({ phase: 'running', elapsed: 65_500, taskIndex: 2, taskTotal: 2, taskId: null, step: 4, action: null, reason: null, timestamp: '' })
      progressListener?.({ phase: 'done', elapsed: 66_000, taskIndex: 0, taskTotal: 0, taskId: null, step: 0, action: null, reason: null, timestamp: '' })
      progressListener?.({ phase: 'error', elapsed: 67_000, taskIndex: 0, taskTotal: 0, taskId: null, step: 0, action: null, reason: null, timestamp: '' })
      return {
        results: [
          { taskId: 'ok', success: true, message: 'done', durationMs: 10 },
          { taskId: 'failed', success: false, message: 'nope', durationMs: 20 },
        ],
      }
    })

    await runCli()

    expect(mocks.ora).toHaveBeenCalled()
    expect(mocks.logger.mute).toHaveBeenCalledOnce()
    expect(mocks.logger.off).toHaveBeenCalledWith('progress', expect.any(Function))
    expect(mocks.logger.unmute).toHaveBeenCalledOnce()
    expect(mocks.spinner.stop).toHaveBeenCalledOnce()
    expect(mocks.spinner.text).toBe('[1m 07s] Error: unknown')
    expect(mocks.logger.info).toHaveBeenCalledWith('  [OK] ok: done (10ms)')
    expect(mocks.logger.info).toHaveBeenCalledWith('  [FAIL] failed: nope (20ms)')
    expect(process.exitCode).toBe(1)
  })

  it('reports a top-level run failure and cleans up TTY progress', async () => {
    setTTY(process.stderr, true)
    mocks.gateway.runOnce.mockRejectedValue(new Error('pipeline failed'))

    await runCli()

    expect(mocks.logger.error).toHaveBeenCalledWith('Run failed', expect.objectContaining({ message: 'pipeline failed' }))
    expect(mocks.spinner.stop).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
  })

  it('lists validated operations, skills, dependencies, and routines', async () => {
    mocks.gateway.getSkillSummaries.mockReturnValue([
      { id: 'welkin-moon', steps: 2, dependsOn: [] },
      { id: 'claim-mail', steps: 3, dependsOn: ['welkin-moon'] },
    ])

    await runCli('skills')

    expect(mocks.logger.info).toHaveBeenCalledWith('Atomic operations:')
    expect(mocks.logger.info).toHaveBeenCalledWith('  welkin-moon — 2 step(s)')
    expect(mocks.logger.info).toHaveBeenCalledWith('  claim-mail — 3 step(s); depends on welkin-moon')
    expect(mocks.logger.info).toHaveBeenCalledWith('  daily: welkin-moon -> claim-mail')
  })

  it('initializes defaults non-interactively and reports created files', async () => {
    mocks.initStateDir.mockResolvedValue({ created: ['/tmp/.giclaw/config.json'] })

    await runCli('init', '--non-interactive')

    expect(mocks.logger.info).toHaveBeenCalledWith('Initialized ~/.giclaw/ at /tmp/.giclaw')
    expect(mocks.logger.info).toHaveBeenCalledWith('  Created /tmp/.giclaw/config.json')

    mocks.initStateDir.mockResolvedValue({ created: [] })
    await runCli('init', '--non-interactive')
    expect(mocks.logger.info).toHaveBeenCalledWith('~/.giclaw/ already initialized at /tmp/.giclaw')
  })

  it('honors cancellation and confirmation when reconfiguring interactively', async () => {
    setTTY(process.stdin, true)
    setTTY(process.stdout, true)
    mocks.wizardConfigured.mockResolvedValue(true)
    mocks.confirm.mockResolvedValue(false)

    await runCli('init')
    expect(mocks.logger.info).toHaveBeenCalledWith('No changes made.')
    expect(mocks.runSetupWizard).not.toHaveBeenCalled()

    mocks.confirm.mockResolvedValue(true)
    await runCli('init')
    expect(mocks.runSetupWizard).toHaveBeenCalledOnce()
  })

  it('shows resolved paths', async () => {
    await runCli('config')

    expect(mocks.logger.info).toHaveBeenCalledWith('configPath: /tmp/.giclaw/config.json')
  })

  it('applies daemon overrides and starts the gateway', async () => {
    await runCli('--headless', '--verbose', 'daemon', '--port', '4321', '--no-web')

    expect(mocks.loadConfig).toHaveBeenCalledWith({
      configPath: undefined,
      cliOverrides: {
        browser: { headless: true },
        web: { port: 4321, enabled: false },
      },
    })
    expect(mocks.logger.setLevel).toHaveBeenCalledWith('debug')
    expect(mocks.startGateway).toHaveBeenCalledWith(config())
  })

  it('rejects daemon startup when the model is not configured', async () => {
    mocks.loadConfig.mockResolvedValue(config({ model: { name: '', baseUrl: '', apiKey: '' } }))

    await runCli('daemon')

    expect(mocks.startGateway).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PATHS } from './paths.js'
import { isModelConfigured, runSetupWizard } from './wizard.js'

const prompts = vi.hoisted(() => ({
  select: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => prompts)

describe('configuration wizard', () => {
  let root: string
  let original: typeof PATHS

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'giclaw-wizard-'))
    original = { ...PATHS }
    Object.assign(PATHS, {
      stateDir: join(root, '.giclaw'),
      configPath: join(root, '.giclaw', 'config.json'),
      dataDir: join(root, '.giclaw', 'data'),
      transcriptsDir: join(root, '.giclaw', 'data', 'transcripts'),
      screenshotDir: join(root, '.giclaw', 'data', 'screenshots'),
      skillsDir: join(root, '.giclaw', 'skills'),
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    Object.assign(PATHS, original)
    await rm(root, { recursive: true, force: true })
  })

  async function writeConfig(value: unknown): Promise<void> {
    await mkdir(dirname(PATHS.configPath), { recursive: true })
    await writeFile(PATHS.configPath, JSON.stringify(value), 'utf-8')
  }

  const mode = (value: { mode: number }) => value.mode & 0o777

  it.each([
    [undefined],
    [{ model: undefined }],
    [{ model: {} }],
    [{ model: { apiKey: '', baseUrl: 'https://example.test', name: 'model' } }],
    [{ model: { apiKey: 'sk-xxx', baseUrl: 'https://example.test', name: 'model' } }],
    [{ model: { apiKey: 'real-key', baseUrl: '', name: 'model' } }],
    [{ model: { apiKey: 'real-key', baseUrl: 'https://example.test', name: '' } }],
  ])('rejects missing or placeholder model configuration %#', async (value) => {
    if (value !== undefined)
      await writeConfig(value)

    await expect(isModelConfigured()).resolves.toBe(false)
  })

  it('accepts a complete model configuration and treats malformed JSON as unconfigured', async () => {
    await writeConfig({
      model: { apiKey: 'real-key', baseUrl: 'https://example.test/v1', name: 'gpt-5.6' },
    })
    await expect(isModelConfigured()).resolves.toBe(true)
    expect(mode(await stat(PATHS.configPath))).toBe(0o600)

    await writeFile(PATHS.configPath, '{invalid', 'utf-8')
    await expect(isModelConfigured()).resolves.toBe(false)
  })

  it('validates answers and deep-merges a selected provider into the existing config', async () => {
    await writeConfig({
      logLevel: 'debug',
      model: { stream: true, family: 'old' },
    })
    prompts.select.mockResolvedValueOnce('en').mockResolvedValueOnce('openai')
    prompts.input.mockResolvedValueOnce('https://api.example.test/v1').mockResolvedValueOnce('gpt-5.6')
    prompts.password.mockResolvedValueOnce('sk-real-secret')
    prompts.confirm.mockResolvedValueOnce(true)

    await runSetupWizard()

    const baseUrlPrompt = prompts.input.mock.calls[0]?.[0] as { validate: (value: string) => true | string }
    const modelPrompt = prompts.input.mock.calls[1]?.[0] as { validate: (value: string) => true | string }
    const keyPrompt = prompts.password.mock.calls[0]?.[0] as { validate: (value: string) => true | string }
    expect(baseUrlPrompt.validate('')).toBe('Base URL is required')
    expect(baseUrlPrompt.validate('ftp://example.test')).toBe('must use HTTPS unless the host is loopback')
    expect(baseUrlPrompt.validate('http://example.test')).toBe('must use HTTPS unless the host is loopback')
    expect(baseUrlPrompt.validate('https://user:password@example.test/')).toBe('must not contain credentials')
    expect(baseUrlPrompt.validate('https://@example.test')).toBe('must not contain credentials')
    expect(baseUrlPrompt.validate('https://example.test/v1?apiKey=secret')).toBe('must not contain query parameters or fragments')
    expect(baseUrlPrompt.validate('https://example.test/v1?')).toBe('must not contain query parameters or fragments')
    expect(baseUrlPrompt.validate('https://example.test/v1#')).toBe('must not contain query parameters or fragments')
    expect(baseUrlPrompt.validate(' http://127.0.0.1:3002/v1')).toBe('must use HTTPS unless the host is loopback')
    expect(baseUrlPrompt.validate('http://127.0.0.2:3002/v1')).toBe('must use HTTPS unless the host is loopback')
    expect(baseUrlPrompt.validate('https://example.test')).toBe(true)
    expect(baseUrlPrompt.validate('http://127.0.0.1:3002/v1')).toBe(true)
    expect(keyPrompt.validate('')).toBe('API key is required')
    expect(keyPrompt.validate('your-api-key-here')).toBe('Please enter a real API key')
    expect(keyPrompt.validate('real')).toBe(true)
    expect(modelPrompt.validate('')).toBe('Model name is required')
    expect(modelPrompt.validate('gpt-5.6')).toBe(true)

    expect(JSON.parse(await readFile(PATHS.configPath, 'utf-8'))).toEqual({
      locale: 'en',
      logLevel: 'debug',
      model: {
        stream: true,
        family: 'openai',
        name: 'gpt-5.6',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-real-secret',
      },
    })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('****cret'))
    expect(mode(await stat(PATHS.configPath))).toBe(0o600)
  })

  it('supports custom providers and missing or non-object existing model values', async () => {
    await writeConfig({ model: 'invalid' })
    prompts.select.mockResolvedValueOnce('zh').mockResolvedValueOnce('custom')
    prompts.input.mockResolvedValueOnce('http://127.0.0.1:3002/v1').mockResolvedValueOnce('gpt-5.6')
    prompts.password.mockResolvedValueOnce('key')
    prompts.confirm.mockResolvedValueOnce(true)

    await runSetupWizard()

    expect(JSON.parse(await readFile(PATHS.configPath, 'utf-8'))).toMatchObject({
      locale: 'zh',
      model: {
        family: '',
        name: 'gpt-5.6',
        baseUrl: 'http://127.0.0.1:3002/v1',
        apiKey: 'key',
      },
    })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('****'))
  })

  it('creates a new config when no prior config file exists', async () => {
    prompts.select.mockResolvedValueOnce('zh').mockResolvedValueOnce('custom')
    prompts.input.mockResolvedValueOnce('https://example.test/v1').mockResolvedValueOnce('model')
    prompts.password.mockResolvedValueOnce('secret')
    prompts.confirm.mockResolvedValueOnce(true)

    await runSetupWizard()

    expect(JSON.parse(await readFile(PATHS.configPath, 'utf-8'))).toMatchObject({
      locale: 'zh',
      model: { name: 'model', baseUrl: 'https://example.test/v1', apiKey: 'secret', family: '' },
    })
    expect(mode(await stat(PATHS.configPath))).toBe(0o600)
  })

  it('repairs permissions when overwriting an existing config', async () => {
    await writeConfig({ model: {} })
    await chmod(PATHS.configPath, 0o666)
    prompts.select.mockResolvedValueOnce('zh').mockResolvedValueOnce('custom')
    prompts.input.mockResolvedValueOnce('https://example.test/v1').mockResolvedValueOnce('model')
    prompts.password.mockResolvedValueOnce('secret')
    prompts.confirm.mockResolvedValueOnce(true)

    await runSetupWizard()

    expect(mode(await stat(PATHS.configPath))).toBe(0o600)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('url-secret'))
  })

  it('does not write when confirmation is declined', async () => {
    prompts.select.mockResolvedValueOnce('zh').mockResolvedValueOnce('custom')
    prompts.input.mockResolvedValueOnce('https://example.test/v1').mockResolvedValueOnce('model')
    prompts.password.mockResolvedValueOnce('secret')
    prompts.confirm.mockResolvedValueOnce(false)

    await runSetupWizard()

    await expect(readFile(PATHS.configPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(console.log).toHaveBeenCalledWith('Setup cancelled.')
  })

  it('handles prompt cancellation but rethrows unexpected prompt errors', async () => {
    prompts.select.mockRejectedValueOnce({ name: 'ExitPromptError' })
    await expect(runSetupWizard()).resolves.toBeUndefined()
    expect(console.log).toHaveBeenCalledWith('\nSetup cancelled.')

    prompts.select.mockRejectedValueOnce(new Error('prompt failed'))
    await expect(runSetupWizard()).rejects.toThrow('prompt failed')
  })
})

import type { ReactNode } from 'react'
import type { LogEntry } from '../../utils/logger.js'
import { Writable } from 'node:stream'
import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import { LogPanel } from './LogPanel.js'
import { StatusBar } from './StatusBar.js'
import { TaskResults } from './TaskResults.js'

const ANSI_PATTERN = new RegExp(`${String.fromCodePoint(27)}\\[[\\d;]*[a-z]`, 'gi')

async function renderText(node: ReactNode): Promise<string> {
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  }) as NodeJS.WriteStream
  Object.defineProperty(stdout, 'columns', { value: 160 })
  Object.defineProperty(stdout, 'rows', { value: 40 })
  const instance = render(node, {
    stdout,
    debug: true,
    patchConsole: false,
  })
  await new Promise(resolve => setImmediate(resolve))
  instance.unmount()
  instance.cleanup()
  return chunks.join('').replace(ANSI_PATTERN, '')
}

describe('tUI status bar', () => {
  it.each([
    [<StatusBar phase="login" currentTask={null} taskIndex={0} taskTotal={0} currentStep={0} elapsed={5_000} currentAction={null} currentReason={null} />, '● Login — Authenticating... (5s)'],
    [<StatusBar phase="running" currentTask="claim-mail" taskIndex={1} taskTotal={2} currentStep={3} elapsed={65_000} currentAction="tap" currentReason="claim" />, '● Running — Task 1/2: claim-mail [Step 3] tap — "claim" (1m 05s)'],
    [<StatusBar phase="running" currentTask={null} taskIndex={2} taskTotal={2} currentStep={3} elapsed={1_000} currentAction={null} currentReason={null} />, '● Running — Task 2/2: [Step 3] (1s)'],
    [<StatusBar phase="running" currentTask={null} taskIndex={0} taskTotal={0} currentStep={0} elapsed={0} currentAction={null} currentReason={null} />, '● Running — (0s)'],
    [<StatusBar phase="done" currentTask={null} taskIndex={0} taskTotal={0} currentStep={0} elapsed={2_000} currentAction={null} currentReason={null} />, '● Done (2s)'],
    [<StatusBar phase="error" currentTask={null} taskIndex={0} taskTotal={0} currentStep={0} elapsed={0} currentAction={null} currentReason="failed" />, '● Error —failed'],
    [<StatusBar phase="error" currentTask={null} taskIndex={0} taskTotal={0} currentStep={0} elapsed={0} currentAction={null} currentReason={null} />, '● Error'],
    [<StatusBar phase="idle" currentTask={null} taskIndex={0} taskTotal={0} currentStep={0} elapsed={0} currentAction={null} currentReason={null} />, '○ Idle'],
  ])('renders phase variant %#', async (node, expected) => {
    expect(await renderText(node)).toContain(expected)
  })
})

describe('tUI log panel', () => {
  function entry(index: number, level: LogEntry['level'] = 'info'): LogEntry {
    return {
      timestamp: '2026-08-07T01:00:00.000Z',
      level,
      message: `message-${index}`,
      args: [],
    }
  }

  it('renders an empty state', async () => {
    expect(await renderText(<LogPanel logs={[]} />)).toContain('No logs')
  })

  it('renders the visible window and both scroll indicators', async () => {
    const logs = Array.from({ length: 20 }, (_, index) => entry(index, index === 2 ? 'debug' : 'info'))

    const output = await renderText(<LogPanel logs={logs} scrollOffset={2} />)

    expect(output).toContain('(4-18/20) ↑ ↓')
    expect(output).toContain('message-3')
    expect(output).toContain('message-17')
    expect(output).not.toContain('message-18')
  })

  it('uses the default color for an unknown runtime log level', async () => {
    const malformed = { ...entry(1), level: 'notice' } as unknown as LogEntry

    expect(await renderText(<LogPanel logs={[malformed]} />)).toContain('[NOTICE] message-1')
  })
})

describe('tUI task results', () => {
  it('renders the pre-run state', async () => {
    expect(await renderText(<TaskResults lastResult={null} />)).toContain('No runs yet')
  })

  it('renders success and both failure message variants', async () => {
    const time = new Date('2026-08-07T01:00:00.000Z')
    const output = await renderText(
      <TaskResults lastResult={{
        startedAt: time,
        completedAt: time,
        results: [
          { taskId: 'success', success: true, message: 'done', durationMs: 1_250, completedAt: time },
          { taskId: 'with-error', success: false, message: 'fallback', durationMs: 2_500, completedAt: time, error: { name: 'Error', message: 'failed hard' } },
          { taskId: 'without-error', success: false, message: 'failed softly', durationMs: 500, completedAt: time },
        ],
      }}
      />,
    )

    expect(output).toContain('1/3 succeeded')
    expect(output).toContain('✓ success')
    expect(output).toContain('1.3s done')
    expect(output).toContain('✗ with-error')
    expect(output).toContain('failed hard')
    expect(output).toContain('failed softly')
  })
})

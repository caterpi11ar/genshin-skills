import { describe, expect, it } from 'vitest'
import {
  AppError,
  cancellationError,
  CancellationError,
  ConfigError,
  LoginError,
  QuarantinedError,
  QueueError,
  SessionError,
  StepExecutionError,
  TaskError,
  TimeoutError,
  toError,
} from './errors.js'

describe('application errors', () => {
  it('preserves Error instances and normalizes other thrown values', () => {
    const original = new Error('original')
    expect(toError(original)).toBe(original)
    expect(toError('plain failure')).toMatchObject({ name: 'Error', message: 'plain failure' })
  })

  it('preserves error codes, names, causes, and structured metadata', () => {
    const cause = new Error('root')
    expect(new AppError('app', 'APP', cause)).toMatchObject({ name: 'AppError', code: 'APP', cause })
    expect(new ConfigError('config', cause)).toMatchObject({ name: 'ConfigError', code: 'CONFIG_ERROR', cause })
    expect(new LoginError('login', cause)).toMatchObject({ name: 'LoginError', code: 'LOGIN_ERROR', cause })
    expect(new SessionError('session', cause)).toMatchObject({ name: 'SessionError', code: 'SESSION_ERROR', cause })
    expect(new QueueError('queue', cause)).toMatchObject({ name: 'QueueError', code: 'QUEUE_ERROR', cause })
    expect(new TaskError('task', 'mail', cause)).toMatchObject({ name: 'TaskError', code: 'TASK_ERROR', taskId: 'mail', cause })
    expect(new StepExecutionError('step', 2, '/tmp/failure.png', cause)).toMatchObject({
      name: 'StepExecutionError',
      code: 'STEP_EXECUTION_ERROR',
      step: 2,
      screenshotPath: '/tmp/failure.png',
      cause,
    })
    expect(new TimeoutError('task:mail', 1000)).toMatchObject({
      name: 'TimeoutError',
      code: 'TIMEOUT',
      message: 'Operation "task:mail" timed out after 1000ms',
    })
    const cancellation = new CancellationError('login', cause)
    expect(cancellation).toMatchObject({
      name: 'CancellationError',
      code: 'CANCELLED',
      cause,
    })
    expect(cancellationError('other', cancellation)).toBe(cancellation)
    expect(cancellationError('task', cause)).toMatchObject({
      name: 'CancellationError',
      cause,
    })
    expect(new QuarantinedError('unsafe cleanup', cause)).toMatchObject({
      name: 'QuarantinedError',
      code: 'QUARANTINED',
      cause,
    })
  })
})

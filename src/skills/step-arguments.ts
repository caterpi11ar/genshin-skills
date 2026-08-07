import type { StepMethod } from './types.js'

export type Direction = 'up' | 'down' | 'left' | 'right'
export type MouseButton = 'left' | 'right' | 'middle'

const DIRECTIONS = new Set<Direction>(['up', 'down', 'left', 'right'])
const MOUSE_BUTTONS = new Set<MouseButton>(['left', 'right', 'middle'])

export function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i)
  if (!match)
    throw new Error(`Invalid duration "${value}" (use milliseconds, e.g. 1500, or seconds, e.g. 1.5s)`)
  const amount = Number(match[1])
  const durationMs = match[2]?.toLowerCase() === 's' ? amount * 1000 : amount
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw new Error(`Invalid duration "${value}"`)
  return Math.round(durationMs)
}

export function parseCoordinates(value: string): [number, number] {
  const parts = value.split(',').map(part => part.trim())
  if (parts.length !== 2 || parts.some(part => !/^-?\d+(?:\.\d+)?$/.test(part)))
    throw new Error(`Invalid coordinates "${value}" (expected "x,y")`)
  return [Number(parts[0]), Number(parts[1])]
}

export function parseArrowArgs(value: string, method: string, rightOptional = false): [string, string?] {
  const index = value.indexOf('=>')
  if (index === -1) {
    if (rightOptional)
      return [value.trim()]
    throw new Error(`${method} expects "value => target description"`)
  }
  const left = value.slice(0, index).trim()
  const right = value.slice(index + 2).trim()
  if (!left || !right)
    throw new Error(`${method} expects non-empty values around "=>"`)
  return [left, right]
}

export function parseMouseButton(value: string): MouseButton {
  const button = value.trim() as MouseButton
  if (!MOUSE_BUTTONS.has(button))
    throw new Error(`Invalid mouse button "${value}" (expected left, right, or middle)`)
  return button
}

export function parseScrollSpec(value: string, method: string): { direction: Direction, distance?: number } {
  const parts = value.trim().split(/\s+/)
  if (parts.length > 2)
    throw new Error(`${method} expects "up|down|left|right [distance]"`)
  const direction = parts[0]?.toLowerCase() as Direction
  if (!DIRECTIONS.has(direction))
    throw new Error(`${method} expects "up|down|left|right [distance]"`)
  const distance = parts[1] ? Number(parts[1]) : undefined
  if (distance !== undefined && (!Number.isFinite(distance) || distance <= 0))
    throw new Error(`Invalid scroll distance "${parts[1]}"`)
  return { direction, distance }
}

/** Validate arguments that have a machine-readable shape during dry-run. */
export function validateStepArgument(method: StepMethod, value: string): void {
  switch (method) {
    case 'aiInput':
      parseArrowArgs(value, method)
      break
    case 'aiScroll': {
      const [spec] = parseArrowArgs(value, method, true)
      parseScrollSpec(spec, method)
      break
    }
    case 'click':
    case 'rightClick':
    case 'move':
      parseCoordinates(value)
      break
    case 'scroll':
      parseScrollSpec(value, method)
      break
    case 'mouseDown':
    case 'mouseUp':
      parseMouseButton(value)
      break
    case 'wait':
      parseDuration(value)
      break
  }
}

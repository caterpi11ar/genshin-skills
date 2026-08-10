import { describe, expect, it } from 'vitest'
import {
  parseArrowArgs,
  parseCoordinates,
  parseDuration,
  parseMouseButton,
  parseScrollSpec,
  validateStepArgument,
} from './step-arguments.js'

describe('step argument parsers', () => {
  it.each([
    ['1500', 1500],
    ['1500ms', 1500],
    ['1.5s', 1500],
    [' 2 s ', 2000],
    ['0', 0],
  ])('parses duration %s', (value, expected) => {
    expect(parseDuration(value)).toBe(expected)
  })

  it.each(['', '-1', '1m', 'soon', '.5s'])('rejects invalid duration %s', (value) => {
    expect(() => parseDuration(value)).toThrow('Invalid duration')
  })

  it('rejects a syntactically valid duration that overflows to infinity', () => {
    expect(() => parseDuration('9'.repeat(400))).toThrow('Invalid duration')
  })

  it('parses finite coordinate pairs', () => {
    expect(parseCoordinates('640, 360')).toEqual([640, 360])
    expect(parseCoordinates('-1.5,2.25')).toEqual([-1.5, 2.25])
  })

  it.each(['640', '640,360,1', 'x,1', '1,Infinity'])('rejects invalid coordinates %s', (value) => {
    expect(() => parseCoordinates(value)).toThrow('Invalid coordinates')
  })

  it('parses required and optional arrow arguments', () => {
    expect(parseArrowArgs('hello => target', 'aiInput')).toEqual(['hello', 'target'])
    expect(parseArrowArgs('Escape', 'aiKeyboardPress', true)).toEqual(['Escape'])
    expect(() => parseArrowArgs('hello', 'aiInput')).toThrow('expects "value => target description"')
    expect(() => parseArrowArgs(' => target', 'aiInput')).toThrow('non-empty')
    expect(() => parseArrowArgs('value => ', 'aiInput')).toThrow('non-empty')
  })

  it.each(['left', 'right', 'middle'] as const)('parses mouse button %s', (button) => {
    expect(parseMouseButton(button)).toBe(button)
  })

  it('rejects unsupported mouse buttons', () => {
    expect(() => parseMouseButton('primary')).toThrow('Invalid mouse button')
  })

  it('parses scroll directions and optional distances', () => {
    expect(parseScrollSpec('down', 'scroll')).toEqual({ direction: 'down', distance: undefined })
    expect(parseScrollSpec('LEFT 250.5', 'scroll')).toEqual({ direction: 'left', distance: 250.5 })
  })

  it.each(['diagonal', 'up 0', 'down -1', 'left many', 'up 1 extra'])('rejects invalid scroll spec %s', (value) => {
    expect(() => parseScrollSpec(value, 'scroll')).toThrow()
  })

  it('validates every machine-readable method and ignores natural-language methods', () => {
    const valid = [
      ['aiInput', 'hello => search box'],
      ['aiScroll', 'down 200 => list'],
      ['aiScroll', 'up'],
      ['click', '1,2'],
      ['rightClick', '1,2'],
      ['move', '1,2'],
      ['scroll', 'right 100'],
      ['mouseDown', 'left'],
      ['mouseUp', 'right'],
      ['wait', '250ms'],
      ['aiAct', 'open the menu'],
    ] as const

    for (const [method, value] of valid)
      expect(() => validateStepArgument(method, value)).not.toThrow()

    expect(() => validateStepArgument('click', 'outside')).toThrow('Invalid coordinates')
    expect(() => validateStepArgument('wait', 'later')).toThrow('Invalid duration')
  })
})

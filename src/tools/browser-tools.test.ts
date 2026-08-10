import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { clickAt, clickCenter, pressKey, scroll, typeText } from './browser-tools.js'

function page(viewport: { width: number, height: number } | null = { width: 1000, height: 500 }) {
  const click = vi.fn(async () => {})
  const wheel = vi.fn(async () => {})
  const type = vi.fn(async () => {})
  const press = vi.fn(async () => {})
  return {
    value: {
      mouse: { click, wheel },
      keyboard: { type, press },
      viewportSize: () => viewport,
    } as unknown as Page,
    click,
    wheel,
    type,
    press,
  }
}

describe('browser tools', () => {
  it('delegates exact click, type, and key operations', async () => {
    const fixture = page()
    await clickAt(fixture.value, 10, 20)
    await typeText(fixture.value, 'hello')
    await pressKey(fixture.value, 'Escape')

    expect(fixture.click).toHaveBeenCalledWith(10, 20)
    expect(fixture.type).toHaveBeenCalledWith('hello')
    expect(fixture.press).toHaveBeenCalledWith('Escape')
  })

  it('maps scroll direction to vertical wheel delta', async () => {
    const fixture = page()
    await scroll(fixture.value, 'up')
    await scroll(fixture.value, 'down')
    expect(fixture.wheel).toHaveBeenNthCalledWith(1, 0, -300)
    expect(fixture.wheel).toHaveBeenNthCalledWith(2, 0, 300)
  })

  it('clicks the actual or fallback viewport center', async () => {
    const actual = page({ width: 1001, height: 501 })
    await clickCenter(actual.value)
    expect(actual.click).toHaveBeenCalledWith(501, 251)

    const fallback = page(null)
    await clickCenter(fallback.value)
    expect(fallback.click).toHaveBeenCalledWith(640, 360)
  })
})

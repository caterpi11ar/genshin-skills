import type { Page } from 'playwright'

/** Click at the given coordinates. */
export async function clickAt(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page.mouse.click(x, y)
}

/** Scroll the page up or down. */
export async function scroll(
  page: Page,
  direction: 'up' | 'down',
): Promise<void> {
  const delta = direction === 'up' ? -300 : 300
  await page.mouse.wheel(0, delta)
}

/** Type text using the keyboard. */
export async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text)
}

/** Press a single key (e.g. "Escape", "Enter"). */
export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
}

/** Click the center of the viewport (useful for canvas activation). */
export async function clickCenter(page: Page): Promise<void> {
  const viewport = page.viewportSize()
  const w = viewport?.width ?? 1280
  const h = viewport?.height ?? 720
  await page.mouse.click(Math.round(w / 2), Math.round(h / 2))
}

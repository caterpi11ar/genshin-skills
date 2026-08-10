import { readFile, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { atomicWritePrivateFile, securePrivateFile } from '../config/paths.js'
import { logger } from '../utils/logger.js'

export interface Cookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

const cookieSchema: z.ZodType<Cookie> = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().finite().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
})

const cookiesSchema = z.array(cookieSchema)

export async function loadCookies(path: string): Promise<Cookie[] | null> {
  try {
    if (!(await securePrivateFile(path)))
      return null
    const raw = await readFile(path, 'utf-8')
    const cookies = cookiesSchema.parse(JSON.parse(raw))
    logger.info('Cookies loaded from file')
    return cookies
  }
  catch (err) {
    logger.warn('Failed to load cookies', err)
    return null
  }
}

export async function saveCookies(path: string, cookies: Cookie[]): Promise<void> {
  const validated = cookiesSchema.parse(cookies)
  await atomicWritePrivateFile(path, JSON.stringify(validated, null, 2))
  logger.info('Cookies saved to file')
}

export async function deleteCookies(path: string): Promise<void> {
  try {
    await unlink(path)
    logger.info('Cookie file deleted')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}

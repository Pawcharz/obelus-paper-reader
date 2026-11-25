import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { GoogleClient } from './google'

/**
 * The Google OAuth client the app signs in with: a "Desktop app" client from Google Cloud Console.
 * Looked for, first found wins: the environment variables OBELUS_GOOGLE_CLIENT_ID and
 * OBELUS_GOOGLE_CLIENT_SECRET; then `google-oauth.json` in the settings folder, either
 * `{ "clientId", "clientSecret" }` or the file Google Cloud Console downloads; then the values
 * built into the app (MAIN_VITE_GOOGLE_CLIENT_ID and MAIN_VITE_GOOGLE_CLIENT_SECRET at build time).
 */
export async function googleClient(settingsDir: string): Promise<GoogleClient | null> {
  const env = process.env
  if (env.OBELUS_GOOGLE_CLIENT_ID && env.OBELUS_GOOGLE_CLIENT_SECRET) {
    return { clientId: env.OBELUS_GOOGLE_CLIENT_ID, clientSecret: env.OBELUS_GOOGLE_CLIENT_SECRET }
  }
  try {
    const raw = JSON.parse(await fs.readFile(join(settingsDir, 'google-oauth.json'), 'utf8')) as Partial<GoogleClient> & {
      installed?: { client_id?: string; client_secret?: string }
    }
    const clientId = raw.clientId ?? raw.installed?.client_id
    const clientSecret = raw.clientSecret ?? raw.installed?.client_secret
    if (clientId && clientSecret) return { clientId, clientSecret }
  } catch {
    /* no file */
  }
  const built = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  if (built.MAIN_VITE_GOOGLE_CLIENT_ID && built.MAIN_VITE_GOOGLE_CLIENT_SECRET) {
    return { clientId: built.MAIN_VITE_GOOGLE_CLIENT_ID, clientSecret: built.MAIN_VITE_GOOGLE_CLIENT_SECRET }
  }
  return null
}

/** Where to put google-oauth.json, shown to the reader when no client is set up. */
export function googleClientFile(settingsDir: string): string {
  return join(settingsDir, 'google-oauth.json')
}

import type { Account, AppSettings } from './types'

/**
 * The folder name under `people/` that holds an account's notes. Built only from the provider's
 * stable id, so it is the same on every computer.
 */
export function accountAuthorId(account: Pick<Account, 'provider' | 'subject'>): string {
  return `${account.provider}-${account.subject.replace(/[^A-Za-z0-9._-]+/g, '-')}`
}

/** Whose notes are shown and written: the signed-in account's, else this computer's own. */
export function currentAuthorId(settings: Pick<AppSettings, 'profile'>): string {
  const { account, authorId } = settings.profile
  return account ? accountAuthorId(account) : authorId
}

/** Whether a `people/` folder belongs to an account rather than to one computer. */
export function isAccountAuthorId(id: string): boolean {
  return /^google-/.test(id)
}

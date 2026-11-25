import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `<parent>/<name>`, after moving `<parent>/<oldName>` there once if only the old folder exists.
 * The app was called Paper Reader before Obelus, and kept its folders under the old names until
 * 0.3.1. If the move fails (another copy of the app still has files open), the old folder is used
 * this time and the move is tried again on the next start.
 */
export function folderMovedOnce(parent: string, oldName: string, name: string): string {
  const target = join(parent, name)
  const old = join(parent, oldName)
  if (existsSync(target) || !existsSync(old)) return target
  try {
    renameSync(old, target)
    return target
  } catch {
    return old
  }
}

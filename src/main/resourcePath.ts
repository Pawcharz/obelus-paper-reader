import { app } from 'electron'
import { join } from 'node:path'

/**
 * A file from the repository's resources folder. An installed app keeps these next to its
 * archive (electron-builder.yml, extraResources), since PowerShell cannot read inside the archive.
 */
export function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name)
}

/** The window icon: Windows takes .ico, Linux a PNG. */
export function windowIconPath(): string {
  return resourcePath(process.platform === 'win32' ? 'icon.ico' : 'icon.png')
}

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folderMovedOnce } from '../../src/main/appFolders'

const tmp = () => mkdtempSync(join(tmpdir(), 'obelus-folders-'))

describe('settings folder named Obelus', () => {
  it('moves the old paper-reader folder, with everything in it, on the first start', () => {
    const parent = tmp()
    mkdirSync(join(parent, 'paper-reader', 'models'), { recursive: true })
    writeFileSync(join(parent, 'paper-reader', 'settings.json'), '{"libraryPath":"x"}')
    expect(folderMovedOnce(parent, 'paper-reader', 'Obelus')).toBe(join(parent, 'Obelus'))
    expect(readFileSync(join(parent, 'Obelus', 'settings.json'), 'utf8')).toBe('{"libraryPath":"x"}')
    expect(existsSync(join(parent, 'Obelus', 'models'))).toBe(true)
    expect(existsSync(join(parent, 'paper-reader'))).toBe(false)
  })

  it('keeps an existing Obelus folder and leaves an old one alone', () => {
    const parent = tmp()
    mkdirSync(join(parent, 'Obelus'))
    mkdirSync(join(parent, 'paper-reader'))
    expect(folderMovedOnce(parent, 'paper-reader', 'Obelus')).toBe(join(parent, 'Obelus'))
    expect(existsSync(join(parent, 'paper-reader'))).toBe(true)
  })

  it('uses the new name on a fresh install', () => {
    const parent = tmp()
    expect(folderMovedOnce(parent, 'paper-reader', 'Obelus')).toBe(join(parent, 'Obelus'))
  })
})

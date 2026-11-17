import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, ChangeEvent } from '../shared/api'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

const channels = [
  'getSettings',
  'updateSettings',
  'pickFolder',
  'defaultLibraryPath',
  'addWorkspace',
  'setActiveWorkspace',
  'listPapers',
  'searchPapers',
  'updatePaper',
  'readPdf',
  'pickPdf',
  'addPaperFromFile',
  'addPaperById',
  'fetchPdfForStub',
  'readFileBytes',
  'loadLayer',
  'saveLayer',
  'saveRegionImage',
  'listSideNotes',
  'createSideNote',
  'saveSideNote',
  'deleteSideNote',
  'deletePaper',
  'listRecognizers',
  'recognize',
  'previewReference',
  'readPreview',
  'addPreview',
  'searchWeb',
  'addReferenceToMap',
  'openExternal',
  'logUsage',
  'usageLogFolder',
  'openUsageLogFolder',
  'listMaps',
  'createMap',
  'saveMap',
  'removeMap'
] as const

const api = Object.fromEntries(channels.map((c) => [c, call(c)])) as unknown as Api

api.pathForFile = (file: File) => webUtils.getPathForFile(file)
api.onChange = (listener: (event: ChangeEvent) => void) => {
  const handler = (_: unknown, event: ChangeEvent) => listener(event)
  ipcRenderer.on('change', handler)
  return () => ipcRenderer.removeListener('change', handler)
}

contextBridge.exposeInMainWorld('api', api)

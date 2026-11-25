import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, ChangeEvent } from '../shared/api'
import type { ModelStatus } from '../shared/types'

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
  'accountStatus',
  'signInWithGoogle',
  'cancelSignIn',
  'signOut',
  'listLayerOwners',
  'mergeLayers',
  'listPapers',
  'searchPapers',
  'updatePaper',
  'readPdf',
  'pickPdf',
  'addPaperFromFile',
  'convertHtml',
  'openOriginal',
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
  'recognizeMath',
  'mathReady',
  'listModels',
  'downloadModel',
  'cancelModelDownload',
  'removeModel',
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

api.onModels = (listener: (status: ModelStatus) => void) => {
  const handler = (_: unknown, status: ModelStatus) => listener(status)
  ipcRenderer.on('models', handler)
  return () => ipcRenderer.removeListener('models', handler)
}

contextBridge.exposeInMainWorld('api', api)

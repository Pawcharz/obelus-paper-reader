import { app, BrowserWindow, Menu, net, protocol, shell } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { windowIconPath } from './resourcePath'

// Settings stay in the same folder whether the app runs from source (named paper-reader) or is
// installed (named Obelus), so installing it keeps your library and settings.
app.setPath('userData', process.env.PAPER_READER_USERDATA ?? join(app.getPath('appData'), 'paper-reader'))

const APP_ORIGIN = 'app://paper'

// PDF.js fetches font data at runtime, which needs a real origin and not file://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

function isSafeExternal(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function serveRenderer(): void {
  const root = join(__dirname, '../renderer')
  protocol.handle('app', (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname)
    const target = normalize(join(root, path === '/' ? 'index.html' : path))
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    autoHideMenuBar: true,
    title: 'Obelus',
    // Window and taskbar icon; the files are built from resources/obelus-icon.svg.
    icon: windowIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => {
    // Opens filling the screen, as a reading app should.
    win.maximize()
    if (!process.env.PAPER_READER_HIDDEN) win.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (!url.startsWith(APP_ORIGIN) && !(dev && url.startsWith(dev))) {
      event.preventDefault()
      if (isSafeExternal(url)) void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}

void app.whenReady().then(async () => {
  // No built-in menu: its shortcuts, such as Ctrl+W closing the whole window, belong to the app.
  Menu.setApplicationMenu(null)
  // Gives Windows its own taskbar identity, so the taskbar shows this icon and not Electron's.
  // The same id as appId in electron-builder.yml, so the installed app keeps it.
  app.setAppUserModelId('com.obelus.reader')
  serveRenderer()
  const dispose = await registerIpc(() => BrowserWindow.getAllWindows()[0] ?? null)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('will-quit', dispose)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

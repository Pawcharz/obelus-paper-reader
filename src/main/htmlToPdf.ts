import { BrowserWindow, session } from 'electron'
import { promises as fs } from 'fs'
import { pathToFileURL } from 'url'
import { pageSizeInches, titleFromHtml, CONTENT_WIDTH_PX, PAGE_MARGIN_IN } from '../shared/htmlReport'

/**
 * Runs inside the report's page before it is printed. Printing an HTML report as it is loses
 * whatever sits inside a scroll box, a closed <details>, a hidden tab or a collapsed section,
 * so this opens all of them and lets each box grow to its full content. It returns the width
 * the content now needs, so the page can be made that wide.
 */
const EXPAND_SCRIPT = String.raw`(() => {
  const css = document.createElement('style')
  css.textContent = [
    'html, body { height: auto !important; max-height: none !important; overflow: visible !important; }',
    'img, svg, canvas, figure, pre, tr, .plotly, .js-plotly-plot, .vega-embed, blockquote { break-inside: avoid; }',
    'h1, h2, h3, h4, h5, h6 { break-after: avoid; }'
  ].join('\n')
  document.head.appendChild(css)

  for (const d of document.querySelectorAll('details')) d.open = true

  // Tabs: show every panel, one after another, with its tab's name above it.
  for (const p of document.querySelectorAll('[role="tabpanel"], .tab-pane')) {
    const was = p.hidden || getComputedStyle(p).display === 'none'
    p.hidden = false
    p.classList.add('active', 'show')
    p.style.setProperty('display', 'block', 'important')
    const id = p.id
    const tab = id ? document.querySelector('[aria-controls="' + CSS.escape(id) + '"], [href="#' + CSS.escape(id) + '"], [data-bs-target="#' + CSS.escape(id) + '"]') : null
    if (was && tab && tab.textContent.trim()) {
      const h = document.createElement('div')
      h.textContent = tab.textContent.trim()
      h.style.cssText = 'font-weight:600;margin:1em 0 0.4em;border-bottom:1px solid #8884;'
      p.before(h)
    }
  }
  // Collapsed sections (Bootstrap and similar).
  for (const c of document.querySelectorAll('.collapse:not(.show), [aria-expanded="false"] + .collapse')) {
    c.classList.add('show')
    c.style.setProperty('display', 'block', 'important')
  }

  // Elements pinned to the screen would repeat on every printed page or cover text.
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el)
    if (s.position === 'fixed') el.style.setProperty('position', 'absolute', 'important')
    else if (s.position === 'sticky') el.style.setProperty('position', 'relative', 'important')
  }

  // Scroll boxes grow to their content. Repeated, since opening an outer box can reveal inner ones.
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0
    for (const el of document.querySelectorAll('body, body *')) {
      const s = getComputedStyle(el)
      const scrollY = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1
      const scrollX = /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1
      if (!scrollY && !scrollX) continue
      el.style.setProperty('overflow', 'visible', 'important')
      if (scrollY) {
        el.style.setProperty('max-height', 'none', 'important')
        el.style.setProperty('height', 'auto', 'important')
      }
      if (scrollX) {
        el.style.setProperty('max-width', 'none', 'important')
        el.style.setProperty('width', 'max-content', 'important')
        el.style.setProperty('min-width', '100%', 'important')
      }
      changed++
    }
    if (!changed) break
  }

  // Let plots that size themselves to their box redraw at the new size.
  window.dispatchEvent(new Event('resize'))
  return Math.ceil(Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0))
})()`

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Turns an HTML report into a PDF the reader can annotate. The page is loaded in a hidden,
 * sandboxed window with no access to the app, given time for its scripts to draw charts,
 * expanded (see EXPAND_SCRIPT) and printed with screen styles, on pages as wide as its content.
 */
export async function htmlToPdf(htmlPath: string, pdfPath: string): Promise<{ title: string }> {
  const html = await fs.readFile(htmlPath, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: CONTENT_WIDTH_PX,
    height: 1200,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Its own session, so a report never sees the app's cookies or storage.
      session: session.fromPartition(`html-report-${Date.now()}`),
      offscreen: false
    }
  })
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  try {
    // A report that never finishes loading (a stuck network request) is printed as far as it got.
    await Promise.race([win.loadURL(pathToFileURL(htmlPath).href), wait(20000)])
    await Promise.race([wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true'), wait(5000)])
    await wait(1500) // charts drawn by scripts after load
    // Print with the styles shown on screen: many reports hide parts of themselves in print styles.
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'screen' })
    const width = Number(await wc.executeJavaScript(EXPAND_SCRIPT)) || CONTENT_WIDTH_PX
    win.setContentSize(Math.max(CONTENT_WIDTH_PX, width), 1200)
    await wait(800) // redraw after the resize
    const finalWidth = Number(await wc.executeJavaScript(
      'Math.ceil(Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0))'
    )) || width
    const size = pageSizeInches(finalWidth)
    const pdf = await wc.printToPDF({
      printBackground: true,
      pageSize: size,
      margins: { top: PAGE_MARGIN_IN, bottom: PAGE_MARGIN_IN, left: PAGE_MARGIN_IN, right: PAGE_MARGIN_IN },
      preferCSSPageSize: false
    })
    await fs.writeFile(pdfPath, pdf)
    return { title: titleFromHtml(html) }
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach()
    win.destroy()
  }
}

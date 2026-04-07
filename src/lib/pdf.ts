let _ready = false

function init() {
  if (_ready) return
  const lib = (window as any).pdfjsLib
  if (!lib) throw new Error('PDF.js not loaded')
  lib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js'
  _ready = true
}

function lib() {
  init()
  return (window as any).pdfjsLib as any
}

/** Load first page of a PDF from a URL or File */
export async function loadPage(source: string | File): Promise<any> {
  const pdfjsLib = lib()
  let doc: any
  if (typeof source === 'string') {
    doc = await pdfjsLib.getDocument({ url: source, withCredentials: false }).promise
  } else {
    const buf = await source.arrayBuffer()
    doc = await pdfjsLib.getDocument({ data: buf }).promise
  }
  return doc.getPage(1)
}

/** Render a PDF page to a canvas at the given scale (default 2 for retina) */
export async function renderPage(
  page: any,
  canvas: HTMLCanvasElement,
  scale = 2
): Promise<{ w: number; h: number }> {
  const vp = page.getViewport({ scale })
  canvas.width = vp.width
  canvas.height = vp.height
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
  return { w: vp.width, h: vp.height }
}

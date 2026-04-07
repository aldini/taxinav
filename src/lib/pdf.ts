import { supabase, BUCKET } from './supabase'

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

/** Load first page of a PDF from Supabase Storage (private bucket) using path */
export async function loadPage(path: string): Promise<any> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error) throw new Error(error.message)
  const buf = await data.arrayBuffer()
  const pdfjsLib = lib()
  const doc = await pdfjsLib.getDocument({ data: buf }).promise
  return doc.getPage(1)
}

/** Load first page of a PDF from a local File (for upload preview) */
export async function loadPageFromFile(file: File): Promise<any> {
  const buf = await file.arrayBuffer()
  const pdfjsLib = lib()
  const doc = await pdfjsLib.getDocument({ data: buf }).promise
  return doc.getPage(1)
}

/** Render a PDF page to a canvas — returns a cancellable task.
 *  Renders at scale × devicePixelRatio for sharp Retina/iPad display.
 *  canvas.style.width/height are set to CSS pixel size (= scale × pdf_units).
 *  All coordinate values (GCP px/py, click positions) live in CSS pixel space. */
export function renderPage(
  page: any,
  canvas: HTMLCanvasElement,
  scale = 2
): { promise: Promise<{ w: number; h: number }>; cancel: () => void } {
  const dpr = Math.min(window.devicePixelRatio || 1, 3) // cap at 3× to limit memory
  const vp = page.getViewport({ scale: scale * dpr })
  // Raw canvas pixels = scale * dpr * pdf_units (high res)
  canvas.width = vp.width
  canvas.height = vp.height
  // CSS size = scale * pdf_units (what layout and coordinates use)
  const cssW = vp.width / dpr
  const cssH = vp.height / dpr
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`

  const ctx = canvas.getContext('2d')!
  const task = page.render({ canvasContext: ctx, viewport: vp })
  const promise = task.promise
    .then(() => ({ w: cssW, h: cssH }))
    .catch((e: any) => {
      if (e?.name === 'RenderingCancelledException') return { w: cssW, h: cssH }
      throw e
    })
  return { promise, cancel: () => task.cancel() }
}

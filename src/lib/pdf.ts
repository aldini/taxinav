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

/** Render a PDF page to a canvas — returns a cancellable task */
export function renderPage(
  page: any,
  canvas: HTMLCanvasElement,
  scale = 2
): { promise: Promise<{ w: number; h: number }>; cancel: () => void } {
  const vp = page.getViewport({ scale })
  canvas.width = vp.width
  canvas.height = vp.height
  const ctx = canvas.getContext('2d')!
  const task = page.render({ canvasContext: ctx, viewport: vp })
  const promise = task.promise
    .then(() => ({ w: vp.width, h: vp.height }))
    .catch((e: any) => {
      if (e?.name === 'RenderingCancelledException') return { w: vp.width, h: vp.height }
      throw e
    })
  return { promise, cancel: () => task.cancel() }
}

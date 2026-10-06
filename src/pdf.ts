import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { extractPdfText } from '../shared/pdfText'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// PDF → text runs in the browser so the Worker stays within its CPU limit.
export async function fileToText(file: File): Promise<string> {
  if (file.type === 'text/plain' || file.name.endsWith('.txt')) return file.text()
  return extractPdfText(pdfjs as never, new Uint8Array(await file.arrayBuffer()))
}

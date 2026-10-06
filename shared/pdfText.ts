// Turns pdf.js text items into plain lines (top-to-bottom, left-to-right).
// Pure, so it runs in the browser (src/pdf.ts) and in Node for tests.

export type PdfTextItem = { str: string; transform: number[]; height?: number }
export type ExtractOptions = {
  /** Law texts (Fedlex): drop footnotes, footnote markers and small running headers by font size. */
  stripFootnotes?: boolean
}

const LINE_TOLERANCE = 3 // PDF units; merges superscripts into their line

/** Most common font size on the page, weighted by characters = the body text size. */
function bodySize(items: PdfTextItem[]): number {
  const weight = new Map<number, number>()
  for (const it of items) {
    const h = Math.round((it.height ?? 0) * 10) / 10
    weight.set(h, (weight.get(h) ?? 0) + it.str.trim().length)
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
}

export function itemsToLines(items: PdfTextItem[], opts: ExtractOptions = {}): string[] {
  const body = opts.stripFootnotes ? bodySize(items) : 0
  const rows: { y: number; parts: { x: number; str: string; small: boolean }[] }[] = []
  for (const it of items) {
    if (!it.str.trim()) continue
    const x = it.transform[4]
    const y = it.transform[5]
    let row = rows.find((r) => Math.abs(r.y - y) <= LINE_TOLERANCE)
    if (!row) rows.push((row = { y, parts: [] }))
    row.parts.push({ x, str: it.str, small: body > 0 && (it.height ?? body) < body * 0.95 })
  }
  rows.sort((a, b) => b.y - a.y)
  const kept = rows
    .map((r) => {
      const parts = r.parts.sort((a, b) => a.x - b.x)
      if (!body) return parts
      // Lines made only of small text are footnotes or running headers → drop.
      if (parts.every((p) => p.small)) return []
      // A small number first on a line is a paragraph number (keep); anywhere else it is a footnote marker.
      return parts.filter((p, i) => !p.small || (i === 0 && /^\d+$/.test(p.str.trim())))
    })
    .filter((parts) => parts.length > 0)
  return kept.map((parts) =>
    parts
      .map((p) => p.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

type PdfPage = {
  streamTextContent?: () => ReadableStream<{ items: unknown[] }>
  getTextContent: () => Promise<{ items: unknown[] }>
}

type PdfjsLike = {
  getDocument: (src: { data: Uint8Array }) => {
    promise: Promise<{ numPages: number; getPage: (n: number) => Promise<PdfPage> }>
  }
}

// pdf.js' getTextContent() iterates a ReadableStream with `for await`, which Safari does not support
// ("undefined is not a function … of …"). Reading the stream with getReader() works in every browser.
async function readTextItems(page: PdfPage): Promise<unknown[]> {
  if (typeof page.streamTextContent !== 'function') return (await page.getTextContent()).items
  const reader = page.streamTextContent().getReader()
  const items: unknown[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value?.items) items.push(...value.items)
  }
  return items
}

export async function extractPdfText(pdfjs: PdfjsLike, data: Uint8Array, opts: ExtractOptions = {}): Promise<string> {
  const doc = await pdfjs.getDocument({ data }).promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const items = (await readTextItems(await doc.getPage(n))).filter(
      (i): i is PdfTextItem => typeof (i as PdfTextItem).str === 'string',
    )
    pages.push(itemsToLines(items, opts).join('\n'))
  }
  return pages.join('\n')
}

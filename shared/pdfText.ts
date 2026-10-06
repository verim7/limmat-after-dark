// Turns pdf.js text items into plain lines (top-to-bottom, left-to-right).
// Pure, so it runs in the browser (src/pdf.ts) and in Node for tests.

export type PdfTextItem = { str: string; transform: number[]; height?: number }

const LINE_TOLERANCE = 3 // PDF units; merges superscripts into their line

export function itemsToLines(items: PdfTextItem[]): string[] {
  const rows: { y: number; parts: { x: number; str: string }[] }[] = []
  for (const it of items) {
    if (!it.str.trim()) continue
    const x = it.transform[4]
    const y = it.transform[5]
    let row = rows.find((r) => Math.abs(r.y - y) <= LINE_TOLERANCE)
    if (!row) rows.push((row = { y, parts: [] }))
    row.parts.push({ x, str: it.str })
  }
  rows.sort((a, b) => b.y - a.y)
  return rows.map((r) =>
    r.parts
      .sort((a, b) => a.x - b.x)
      .map((p) => p.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

type PdfjsLike = {
  getDocument: (src: { data: Uint8Array }) => {
    promise: Promise<{
      numPages: number
      getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>
    }>
  }
}

export async function extractPdfText(pdfjs: PdfjsLike, data: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data }).promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent()
    const items = content.items.filter((i): i is PdfTextItem => typeof (i as PdfTextItem).str === 'string')
    pages.push(itemsToLines(items).join('\n'))
  }
  return pages.join('\n')
}

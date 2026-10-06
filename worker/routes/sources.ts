import { Hono } from 'hono'

// Official regulation PDFs the app may fetch server-side (links from the exercise sheet, p. 2).
// Fixed allowlist — this is not an open proxy.
export const SOURCES: Record<string, { url: string; filename: string; expectedStand: string }> = {
  'fidleg-de-2026-10-01': {
    url: 'https://bfadmin.cdbf.ch/Serveur/documents/8333',
    filename: 'FIDLEG_SR-950.1_de_Stand_2026-10-01.pdf',
    expectedStand: '1. Oktober 2026',
  },
}

export const sources = new Hono()

sources.get('/sources/:key', async (c) => {
  const source = SOURCES[c.req.param('key')]
  if (!source) return c.json({ error: 'unknown source' }, 404)
  const res = await fetch(source.url, { headers: { 'User-Agent': 'limmat-after-dark gap check' } })
  if (!res.ok) return c.json({ error: `Source returned HTTP ${res.status}` }, 502)
  const bytes = new Uint8Array(await res.arrayBuffer())
  // Only pass through real PDFs ("%PDF").
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return c.json({ error: 'Source did not return a PDF' }, 502)
  }
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'X-Source-Url': source.url,
      'X-Source-Filename': source.filename,
      'X-Expected-Stand': source.expectedStand,
      'Cache-Control': 'private, max-age=3600',
    },
  })
})

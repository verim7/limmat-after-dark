// Deterministic splitting of the two source texts into citable sections.
// No AI here: every section id/ref is derived from the numbering in the text itself.

export type Section = {
  sid: string // short id the AI step cites, e.g. "A8.1" or "P4.2"
  ref: string // human reference, e.g. "Art. 8 Abs. 1 FIDLEG" or "W-07 Ziff. 4.2"
  heading: string
  text: string
  ord: number
}

/** Joins wrapped lines; repairs end-of-line hyphenation ("Finanz-\nleistung" → "Finanzleistung"). */
export function joinLines(lines: string[]): string {
  let out = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (!out) out = line
    else if (/[a-zäöü]-$/.test(out) && /^[a-zäöü]/.test(line)) out = out.slice(0, -1) + line
    else out += ' ' + line
  }
  return out
}

/** Whitespace/Unicode normalisation used for verbatim-quote checks. */
export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .replace(/­/g, '')
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when `quote` appears verbatim (after normalisation) in `sectionText`. */
export function quoteIsVerbatim(sectionText: string, quote: string): boolean {
  const q = normalize(quote)
  return q.length >= 8 && normalize(sectionText).includes(q)
}

// ---------------------------------------------------------------------------
// Internal policy (Weisung): "N. Title" headings and "N.M text" clauses.

const POLICY_FOOTER = /^FICTIONAL TEST DATA\b|^Seite \d+$/

export function segmentPolicy(text: string, docLabel = 'W-07'): Section[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !POLICY_FOOTER.test(l))
  const sections: Section[] = []
  let heading = { n: 0, title: 'Kopf' }
  let current: { sid: string; ref: string; heading: string; lines: string[] } | null = {
    sid: 'P0',
    ref: `${docLabel} Kopf`,
    heading: 'Titel und Metadaten',
    lines: [],
  }
  let clauseNo = 0

  const flush = () => {
    if (current && current.lines.length) {
      sections.push({
        sid: current.sid,
        ref: current.ref,
        heading: current.heading,
        text: joinLines(current.lines),
        ord: sections.length,
      })
    }
    current = null
  }

  for (const line of lines) {
    const h = line.match(/^(\d+)\.\s+(\D.*)$/)
    const c = line.match(/^(\d+)\.(\d+)\s+(.+)$/)
    if (h && Number(h[1]) === heading.n + 1) {
      flush()
      heading = { n: Number(h[1]), title: h[2] }
      clauseNo = 0
      current = { sid: `P${heading.n}`, ref: `${docLabel} Ziff. ${heading.n}`, heading: `${heading.n}. ${heading.title}`, lines: [] }
    } else if (c && Number(c[1]) === heading.n && Number(c[2]) === clauseNo + 1) {
      flush()
      clauseNo = Number(c[2])
      const no = `${heading.n}.${clauseNo}`
      current = { sid: `P${no}`, ref: `${docLabel} Ziff. ${no}`, heading: `${heading.n}. ${heading.title}`, lines: [c[3]] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()
  return sections
}

// ---------------------------------------------------------------------------
// Regulation (Swiss federal act, Fedlex layout): "Art. N <title>" and numbered paragraphs.
// DRAFT: page header/footer and footnote handling must be confirmed on the real FIDLEG PDF.

export type RegulationOptions = { fromArt: number; toArt: number; law: string }

const REG_NOISE = [
  /^\d{1,4}$/, // page numbers
  /^SR \d{3}(\.\d+)*$/, // running header "SR 950.1"
  /^\d{3}(\.\d+)+$/, // running header "950.1"
]

/** The status date printed on Fedlex PDFs, e.g. "(Stand am 1. Oktober 2026)". */
export function findStand(text: string): string | null {
  return normalize(text).match(/Stand am (\d{1,2}\. [A-Za-zäÄ]+ \d{4})/)?.[1] ?? null
}

export function segmentRegulation(text: string, opts: RegulationOptions): Section[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !REG_NOISE.some((r) => r.test(l)))
  const sections: Section[] = []
  let art: { n: number; suffix: string; title: string } | null = null
  let para = 0
  let current: { sid: string; ref: string; heading: string; lines: string[] } | null = null

  const artKey = (n: number, suffix: string) => n * 100 + (suffix ? suffix.charCodeAt(0) - 96 : 0)
  const inScope = () => art !== null && art.n >= opts.fromArt && art.n <= opts.toArt
  const flush = () => {
    if (current && current.lines.length && inScope()) {
      sections.push({ sid: current.sid, ref: current.ref, heading: current.heading, text: joinLines(current.lines), ord: sections.length })
    }
    current = null
  }

  for (const line of lines) {
    // Article heading: "Art. 8", "Art. 8 Titel" or "Art. 8a Titel" — numbers only ever increase, which keeps
    // in-text cross references ("… gemäss Art. 10 Abs. 2") from being read as headings.
    const a = line.match(/^Art\.\s*(\d+)([a-z]?)(?:\s+(?!Abs\.|Bst\.|lit\.)([A-ZÄÖÜ].*))?$/)
    if (a && (art === null || artKey(Number(a[1]), a[2]) > artKey(art.n, art.suffix))) {
      flush()
      art = { n: Number(a[1]), suffix: a[2], title: a[3] ?? '' }
      para = 0
      const no = `${art.n}${art.suffix}`
      current = { sid: `A${no}`, ref: `Art. ${no} ${opts.law}`, heading: `Art. ${no} ${art.title}`.trim(), lines: [] }
      continue
    }
    if (!art) continue
    const no = `${art.n}${art.suffix}`
    const p = line.match(/^(\d{1,2})\s+(\S.*)$/)
    if (p && Number(p[1]) === para + 1) {
      flush()
      para = Number(p[1])
      current = { sid: `A${no}.${para}`, ref: `Art. ${no} Abs. ${para} ${opts.law}`, heading: `Art. ${no} ${art.title}`.trim(), lines: [p[2]] }
      continue
    }
    if (!current) continue
    // Heading line was only "Art. N": the next line before any paragraph is the article title.
    if (para === 0 && !art.title && current.lines.length === 0) {
      art.title = line
      current.heading = `Art. ${no} ${line}`
      continue
    }
    current.lines.push(line)
  }
  flush()
  return sections
}

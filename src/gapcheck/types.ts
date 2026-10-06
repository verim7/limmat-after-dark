export type Rating = 'covered' | 'partial' | 'missing'

export type Section = { sid: string; kind: 'regulation' | 'policy'; ref: string; heading: string; text: string; ord: number }

export type Requirement = {
  rid: string
  section_sid: string
  ref_label: string
  quote: string
  summary: string
  section?: Section
  refVerified: boolean
  quoteVerified: boolean
  assessment: null | {
    policy_sids: string[]
    policy_quote: string
    rating: Rating
    reason: string
    proposed_text: string
    policySections: Section[]
    policyVerified: boolean
  }
}

export type RunData = {
  run: null | { id: string; status: 'awaiting_ai' | 'assessed'; created_at: string }
  documents?: { kind: string; filename: string }[]
  sections?: { regulation: Section[]; policy: Section[] }
  requirements?: Requirement[]
}

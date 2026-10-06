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
    review_status: 'pending' | 'confirmed' | 'overridden'
    final_rating: Rating | null
    review_comment: string
    reviewer_name: string | null
    reviewed_at: string | null
    impact_policy_id: string
    impact_confirmed: boolean
    effectiveRating: Rating
  }
}

export type Task = { rid: string; policy_id: string; title: string; owner: string; due_date: string; status: 'open' | 'done' }

export type RegisterEntry = { id: string; title: string; owner: string; regulatory_basis: string }

export type RunData = {
  run: null | { id: string; status: 'awaiting_ai' | 'assessed'; engine: string | null; created_at: string }
  documents?: { kind: string; filename: string }[]
  sections?: { regulation: Section[]; policy: Section[] }
  requirements?: Requirement[]
  tasks?: Task[]
}

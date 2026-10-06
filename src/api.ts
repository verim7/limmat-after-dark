import { useAuth } from '@clerk/react'
import { useCallback } from 'react'

// fetch() wrapper that attaches the Clerk session token so the Worker can verify it.
export function useApi() {
  const { getToken } = useAuth()
  return useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = await getToken()
      const res = await fetch(`/api${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      })
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      return (res.status === 204 ? null : await res.json()) as T
    },
    [getToken],
  )
}

// Raw fetch with the Clerk token, for non-JSON responses (e.g. PDFs).
export function useAuthedFetch() {
  const { getToken } = useAuth()
  return useCallback(
    async (url: string) => {
      const token = await getToken()
      return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    },
    [getToken],
  )
}

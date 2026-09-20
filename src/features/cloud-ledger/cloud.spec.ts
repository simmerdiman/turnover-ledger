import { signInWithPassword, setAccountPassword, authError, CloudError } from './cloud'
import { describe, expect, it, vi } from 'vitest'
import { equal, reconcile, type Cache, type Document } from './cloud'
import type { ReportState } from '@/entities/report/model/types'

const payload = { meta: { header: {}, footer: {} }, rows: [] } as unknown as ReportState
const local: Cache = { payload, version: 2, dirty: true }
const remote: Document = {
  payload: { ...payload, rows: [{ id: 'other-device' }] } as ReportState,
  version: 3,
  updated_at: '',
}
describe('cloud reconciliation', () => {
  it('does not overwrite a newer remote document with offline edits', () =>
    expect(reconcile(local, remote)).toBe('conflict'))
  it('retries an offline edit only against its original version', () =>
    expect(reconcile(local, { ...remote, version: 2 })).toBe('pending'))
  it('accepts a save acknowledged by the server after the browser missed the response', () =>
    expect(reconcile(local, { ...remote, payload })).toBe('remote'))
  it('loads the newest remote version when this device has no unsaved edits', () =>
    expect(reconcile({ ...local, dirty: false }, remote)).toBe('remote'))
  it('does not recreate a disappeared document using a stale version', () =>
    expect(reconcile(local, null)).toBe('conflict'))
  it('allows a first save when there is no remote document', () =>
    expect(reconcile({ ...local, version: 0 }, null)).toBe('pending'))
  it('treats PostgreSQL JSON key ordering as equivalent', () =>
    expect(equal({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true))
  it('preserves meaningful row order', () => expect(equal([1, 2], [2, 1])).toBe(false))
})

describe('password sign-in', () => {
  it('uses the password endpoint without sending an email and does not persist the password', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'test-token',
          refresh_token: 'test-refresh',
          expires_in: 3600,
          user: { id: 'test-user' },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await signInWithPassword(' Owner@Example.com ', 'test-only-password')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]![0]).toContain('/auth/v1/token?grant_type=password')
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
        email: 'owner@example.com',
        password: 'test-only-password',
      })
      expect([...values.values()].join('')).not.toContain('test-only-password')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('updates only the current authenticated user using PUT', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          access_token: 'test-token',
          refresh_token: 'test-refresh',
          expires_at: Date.now() / 1000 + 3600,
          user: { id: 'test-user' },
        }),
    })
    vi.stubGlobal('navigator', {})
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'test-user' }) })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await setAccountPassword('test-only-password')
      expect(fetchMock.mock.calls[0]![0]).toContain('/auth/v1/user')
      expect(fetchMock.mock.calls[0]![1].method).toBe('PUT')
      expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer test-token')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('explains the mail limit without claiming the database is offline', () => {
    expect(authError(new CloudError(429, 'over_email_send_rate_limit', 'email rate limit exceeded'))).toContain(
      'лимит писем',
    )
  })
})

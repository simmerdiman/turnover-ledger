import { describe, expect, it } from 'vitest'
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

import { isReportState } from '@/entities/report/model/lib'
import type { ReportState } from '@/entities/report/model/types'

const API_URL = 'https://omumgsmurncqmvmxjkly.supabase.co'
const KEY = 'sb_publishable_RUmTJ3Y089AQEKDQhxAaqA_DJBNjMyi'
const SESSION_KEY = 'kpo-cloud-session-v1'
export type Session = {
  access_token: string
  refresh_token: string
  expires_at: number
  user: { id: string; email?: string }
}
export type Document = { payload: ReportState; version: number; updated_at: string }
export type Cache = { payload: ReportState; version: number; dirty: boolean }
export class CloudError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request(path: string, body?: unknown, token?: string, method?: string): Promise<unknown> {
  const response = await fetch(API_URL + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      apikey: KEY,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw new CloudError(
      response.status,
      data?.code ?? data?.error_code ?? '',
      data?.msg ?? data?.message ?? 'Ошибка соединения',
    )
  return data
}

export function session(): Session | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')
    return value?.access_token && value?.refresh_token && value?.user?.id ? value : null
  } catch {
    return null
  }
}

function remember(value: unknown): Session {
  const data = value as Session & { expires_in?: number }
  if (!data?.access_token || !data?.refresh_token || !data?.user?.id) throw new Error('Не удалось подтвердить вход')
  data.expires_at ||= Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600)
  localStorage.setItem(SESSION_KEY, JSON.stringify(data))
  return data
}

export async function sendCode(email: string) {
  const redirect = new URL(import.meta.env.BASE_URL, location.origin).href
  await request(`/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
    email: email.trim().toLowerCase(),
    create_user: true,
  })
}
export async function signInWithPassword(email: string, password: string) {
  return remember(
    await request('/auth/v1/token?grant_type=password', {
      email: email.trim().toLowerCase(),
      password,
    }),
  )
}
export async function setAccountPassword(password: string) {
  await request('/auth/v1/user', { password }, await accessToken(), 'PUT')
}
export function authError(reason: unknown): string {
  if (reason instanceof CloudError) {
    if (reason.status === 429 || /rate.limit/i.test(reason.message))
      return 'Достигнут лимит писем. Используй пароль или уже полученную ссылку. Новое письмо можно запросить позже.'
    if (reason.code === 'invalid_credentials' || /invalid login credentials/i.test(reason.message))
      return 'Неверная почта или пароль. Если пароль ещё не задан, открой КПО там, где ты уже вошёл, и нажми «Задать пароль».'
    if (reason.code === 'email_not_confirmed') return 'Сначала подтверди почту по ссылке из письма.'
    if (reason.code === 'weak_password') return 'Выбери более надёжный пароль: минимум 12 символов.'
  }
  return reason instanceof Error ? reason.message : 'Не удалось выполнить вход. Попробуй ещё раз.'
}

export async function verifyCode(email: string, token: string) {
  return remember(
    await request('/auth/v1/verify', { email: email.trim().toLowerCase(), token: token.trim(), type: 'email' }),
  )
}

export async function receiveEmailLink() {
  const params = new URLSearchParams(location.hash.slice(1))
  if (!params.has('access_token')) return
  // Remove credentials from the address before the router or other services initialize.
  history.replaceState(null, '', location.pathname + location.search)
  const access_token = params.get('access_token')!
  const refresh_token = params.get('refresh_token')
  if (!refresh_token) throw new Error('Неполная ссылка входа. Запроси новое письмо.')
  const user = await request('/auth/v1/user', undefined, access_token)
  remember({
    access_token,
    refresh_token,
    expires_at:
      Number(params.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(params.get('expires_in') || 3600),
    user,
  })
}

export async function accessToken(): Promise<string> {
  const refresh = async () => {
    const current = session()
    if (!current) throw new CloudError(401, 'no_session', 'Войди снова')
    if (current.expires_at > Date.now() / 1000 + 90) return current.access_token
    try {
      return remember(
        await request('/auth/v1/token?grant_type=refresh_token', { refresh_token: current.refresh_token }),
      ).access_token
    } catch (error) {
      if (error instanceof CloudError && [400, 401, 403].includes(error.status)) {
        localStorage.removeItem(SESSION_KEY)
        throw new CloudError(401, 'expired_session', 'Войди снова')
      }
      throw error
    }
  }
  return navigator.locks ? navigator.locks.request('kpo-auth-refresh', refresh) : refresh()
}

export async function permitted() {
  return (await request('/rest/v1/rpc/ledger_allowed', {}, await accessToken())) === true
}
export async function loadDocument(): Promise<Document | null> {
  const data = await request(
    '/rest/v1/ledger_documents?select=payload,version,updated_at',
    undefined,
    await accessToken(),
  )
  if (!Array.isArray(data)) throw new Error('Неверный ответ хранилища')
  if (!data.length) return null
  if (!isReportState(data[0].payload) || !Number.isSafeInteger(data[0].version))
    throw new Error('Не удалось прочитать записи')
  return data[0]
}
export async function saveDocument(payload: ReportState, version: number): Promise<Document> {
  const data = await request(
    '/rest/v1/rpc/save_ledger',
    { doc: payload, expected_version: version },
    await accessToken(),
  )
  if (!Array.isArray(data) || !data[0] || !isReportState(data[0].payload)) throw new Error('Сохранение не подтверждено')
  return data[0]
}

export const cacheKey = (id: string) => `kpo-cloud-data-v1:${id}`
export function readCache(id: string): Cache | null {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey(id)) ?? 'null')
    return value &&
      isReportState(value.payload) &&
      Number.isSafeInteger(value.version) &&
      typeof value.dirty === 'boolean'
      ? value
      : null
  } catch {
    return null
  }
}
export function writeCache(id: string, value: Cache) {
  localStorage.setItem(cacheKey(id), JSON.stringify(value))
}
export function equal(a: unknown, b: unknown): boolean {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, value]) => [k, normalize(value)]),
          )
        : v
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}
export function reconcile(cache: Cache | null, remote: Document | null): 'remote' | 'pending' | 'conflict' {
  if (!cache?.dirty || equal(cache.payload, remote?.payload)) return 'remote'
  return cache.version === (remote?.version ?? 0) ? 'pending' : 'conflict'
}
export async function signOut(id: string) {
  const current = session()
  if (current) {
    await fetch(API_URL + '/auth/v1/logout?scope=local', {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${current.access_token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  localStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(cacheKey(id))
  localStorage.removeItem('reportState')
}

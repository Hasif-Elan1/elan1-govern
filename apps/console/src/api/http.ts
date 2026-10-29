/**
 * The console's HTTP client for the real backend (live builds). Same origin only: the API is served by the same
 * Next.js app that serves the console (or proxied to it by Vite in development), so the session cookie, the CSRF
 * token and the Origin check work exactly as they do for every other page. No CORS, no tokens in storage.
 *
 *  - Every write carries `x-csrf-token`: the session's token once signed in (GET /api/me hands it over), or the
 *    double-submit `gate_csrf` cookie before that (sign-in, recovery).
 *  - `{ error }` answers become an HttpError with the server's sentence; a 429 says when to try again.
 *  - `{ reauth: true }` (an action that needs a sign-in within 10 minutes) opens the console's re-authentication
 *    dialog and, once the person has confirmed it is them, sends the request once more.
 *  - Any other 401 means the server ended the session: the console signs out locally (see setHttpHooks).
 */

export const CSRF_COOKIE = 'gate_csrf';

/** The server refused or failed: `status` and the answer's other fields (needTotp, sso, suspended …) are kept. */
export class HttpError extends Error {
  readonly status: number;
  readonly data: Record<string, unknown>;
  readonly retryAfter?: number;
  constructor(status: number, message: string, data: Record<string, unknown> = {}, retryAfter?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.data = data;
    this.retryAfter = retryAfter;
  }
}

/** The server could not be reached at all. */
export class NetworkError extends Error {
  constructor(message = 'Elan1 Govern cannot be reached right now. Check your connection and try again.') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface HttpHooks {
  /** Ask the person to confirm it is them (password, and the 6-digit code when asked). True when they did. */
  reauth?: () => Promise<boolean>;
  /** The server no longer knows this session. */
  signedOut?: () => void;
  /** A request could not reach the server. */
  offline?: () => void;
  /** A request reached it again after `offline`. */
  online?: () => void;
}

interface Config {
  hooks: HttpHooks;
  csrf?: string;
  fetch: typeof fetch;
  cookies: () => string;
  offline: boolean;
}

const config: Config = {
  hooks: {},
  fetch: (...a) => fetch(...a),
  cookies: () => (typeof document === 'undefined' ? '' : document.cookie),
  offline: false,
};

export function setHttpHooks(hooks: HttpHooks) {
  config.hooks = hooks;
}

/** The signed-in session's CSRF token (from GET /api/me), or undefined to fall back to the cookie. */
export function setCsrfToken(token: string | undefined) {
  config.csrf = token;
}

/** For tests: a fake fetch and cookie jar. */
export function setTransport(t: { fetch?: typeof fetch; cookies?: () => string }) {
  if (t.fetch) config.fetch = t.fetch;
  if (t.cookies) config.cookies = t.cookies;
}

export function cookie(name: string): string | undefined {
  for (const part of config.cookies().split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return undefined;
}

export function csrfToken(): string | undefined {
  return config.csrf ?? cookie(CSRF_COOKIE);
}

export interface RequestOptions {
  /** Do not open the re-authentication dialog on `{ reauth: true }` (the dialog's own requests). */
  noReauth?: boolean;
  /** A 401 here is an answer (wrong password), not the end of the session. */
  noSignOut?: boolean;
  signal?: AbortSignal;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const seconds = (n: number) => `${n} second${n === 1 ? '' : 's'}`;

/** The sentence for a refusal: the server's, with when to try again for a 429 that does not say. */
function messageOf(status: number, data: Record<string, unknown>, retryAfter?: number): string {
  const said = typeof data.error === 'string' && data.error.trim() ? data.error.trim() : undefined;
  if (status === 429) {
    const base = said ?? 'Too many requests.';
    if (retryAfter === undefined || /\d/.test(base)) return base;
    return `${base.replace(/\.?$/, '.')} Try again in ${seconds(retryAfter)}.`;
  }
  if (said) return said;
  if (status === 401) return 'Sign in to continue.';
  if (status === 403) return 'You do not have access to this.';
  if (status === 404) return 'That was not found.';
  if (status >= 500) return 'Something went wrong on our side. Nothing was changed.';
  return `The request failed (${status}).`;
}

async function send(method: Method, path: string, body: unknown, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }
  try {
    const res = await config.fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (config.offline) {
      config.offline = false;
      config.hooks.online?.();
    }
    return res;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    if (!config.offline) {
      config.offline = true;
      config.hooks.offline?.();
    }
    throw new NetworkError();
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

const fields = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * One request to the backend. Resolves with the JSON answer; rejects with HttpError (a refusal), NetworkError (no
 * connection) or the AbortError of `signal`.
 */
export async function http<T = Record<string, unknown>>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('The console only calls its own server.');
  for (let attempt = 0; ; attempt++) {
    const res = await send(method, path, body, opts);
    const parsed = await readJson(res);
    if (res.ok) return parsed as T;
    const data = fields(parsed);
    const header = Number(res.headers.get('retry-after'));
    const retryAfter = typeof data.retryAfter === 'number' ? data.retryAfter : Number.isFinite(header) && header > 0 ? header : undefined;
    if (res.status === 401 && data.reauth === true && !opts.noReauth && attempt === 0 && config.hooks.reauth) {
      if (await config.hooks.reauth()) continue;
      throw new HttpError(401, 'Confirm it is you to continue. Nothing was changed.', data);
    }
    if (res.status === 401 && data.reauth !== true && !opts.noSignOut) config.hooks.signedOut?.();
    throw new HttpError(res.status, messageOf(res.status, data, retryAfter), data, retryAfter);
  }
}

export const get = <T = Record<string, unknown>>(path: string, opts?: RequestOptions) => http<T>('GET', path, undefined, opts);
export const post = <T = Record<string, unknown>>(path: string, body?: unknown, opts?: RequestOptions) => http<T>('POST', path, body ?? {}, opts);
export const put = <T = Record<string, unknown>>(path: string, body?: unknown, opts?: RequestOptions) => http<T>('PUT', path, body ?? {}, opts);
export const del = <T = Record<string, unknown>>(path: string, opts?: RequestOptions) => http<T>('DELETE', path, undefined, opts);

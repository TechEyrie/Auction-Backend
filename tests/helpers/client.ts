export type ApiResponse<T = unknown> = { status: number; body: T; headers: Headers };

/** Minimal browser-like client: keeps cookies and echoes the CSRF token as a header. */
export class TestClient {
  private cookies = new Map<string, string>();
  private csrf: string | null = null;
  private readonly baseUrl: string;
  private readonly useCsrf: boolean;

  constructor(baseUrl: string, useCsrf = true) {
    this.baseUrl = baseUrl;
    this.useCsrf = useCsrf;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { csrf?: boolean; headers?: Record<string, string>; origin?: string } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = this.cookieHeader();
    if (cookie) headers['cookie'] = cookie;
    if (opts.csrf ?? this.useCsrf) {
      if (this.csrf) headers['x-csrf-token'] = this.csrf;
    }
    if (opts.origin) headers['origin'] = opts.origin;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });

    const setCookies = (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const pair = raw.split(';')[0] ?? '';
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx);
      let value = pair.slice(idx + 1);
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep raw */
      }
      if (value === '') {
        this.cookies.delete(name);
        if (name === 'csrf') this.csrf = null;
      } else {
        this.cookies.set(name, value);
        if (name === 'csrf') this.csrf = value;
      }
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = unknown>(path: string, opts?: Parameters<TestClient['request']>[3]) {
    return this.request<T>('GET', path, undefined, opts);
  }
  post<T = unknown>(path: string, body?: unknown, opts?: Parameters<TestClient['request']>[3]) {
    return this.request<T>('POST', path, body, opts);
  }
  patch<T = unknown>(path: string, body?: unknown, opts?: Parameters<TestClient['request']>[3]) {
    return this.request<T>('PATCH', path, body, opts);
  }

  /** Fetch the CSRF cookie/token before the first mutation. */
  bootstrap() {
    return this.get('/api/auth/session');
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }
  clearCookie(name: string): void {
    this.cookies.delete(name);
  }
  csrfToken(): string | null {
    return this.csrf;
  }
  setCsrfToken(value: string | null): void {
    this.csrf = value;
  }
}

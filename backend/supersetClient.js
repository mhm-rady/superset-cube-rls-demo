// Minimal Superset REST API client: login -> CSRF -> guest token (plus a
// generic CSRF-protected request helper for scripts/bootstrap.mjs's
// provisioning calls).
//
// Zero npm dependencies on purpose -- only the Node 22 built-in `fetch` --
// so this same file can be imported both by backend/server.js (inside its
// container, talking to http://superset:8088) and by scripts/bootstrap.mjs
// (run directly on the host, with no node_modules, talking to
// http://localhost:8088).
//
// CSRF is NOT in Superset's exemption list for the guest-token endpoint (or
// most write endpoints), and Flask-WTF's CSRF check requires the SAME
// session that minted the token, plus a matching Referer header. A bare
// fetch() with no cookie jar loses the session between calls, so this
// client tracks its own Cookie header explicitly instead of relying on
// fetch's (browser-only) automatic cookie handling.

export class SupersetApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'SupersetApiError';
    this.status = status;
    this.body = body;
  }
}

export function createSupersetClient(baseUrl) {
  let cookieJar = '';
  let accessToken = null;

  function captureCookies(response) {
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
    if (cookies.length > 0) {
      cookieJar = cookies.map((c) => c.split(';')[0]).join('; ');
    }
  }

  async function request(method, urlPath, { body, headers = {}, auth = true } = {}) {
    const finalHeaders = { ...headers };
    if (cookieJar) finalHeaders['Cookie'] = cookieJar;
    if (auth && accessToken) finalHeaders['Authorization'] = `Bearer ${accessToken}`;
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';

    const response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    captureCookies(response);

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new SupersetApiError(`Superset API ${method} ${urlPath} -> ${response.status}: ${text}`, {
        status: response.status,
        body: data,
      });
    }
    return data;
  }

  async function login(username, password) {
    const data = await request('POST', '/api/v1/security/login', {
      auth: false,
      body: { username, password, provider: 'db', refresh: true },
    });
    accessToken = data.access_token;
    return accessToken;
  }

  async function fetchCsrfToken() {
    const data = await request('GET', '/api/v1/security/csrf_token/');
    return data.result;
  }

  /**
   * Any write call needs a fresh CSRF token and a Referer header -- both
   * are easy to forget and both fail with an opaque 400. Centralized here
   * so every caller (bootstrap.mjs's provisioning calls, and
   * mintGuestToken below) goes through the same path.
   */
  async function withCsrf(method, urlPath, body) {
    const csrfToken = await fetchCsrfToken();
    return request(method, urlPath, {
      headers: { 'X-CSRFToken': csrfToken, Referer: `${baseUrl}/` },
      body,
    });
  }

  async function mintGuestToken({ username, firstName, lastName, resources, rls }) {
    if (!username) {
      // Hazard: an empty/missing username silently disables ALL guest RLS
      // in Superset 4.1.3-6.1.0 inclusive (is_guest_user() gates on a
      // truthy username) -- every row comes back with no error. Fail loudly
      // here instead of minting a token that quietly leaks everything.
      throw new Error('mintGuestToken: username is required and must be non-empty');
    }
    const data = await withCsrf('POST', '/api/v1/security/guest_token/', {
      user: { username, first_name: firstName, last_name: lastName },
      resources,
      rls,
    });
    return data.token;
  }

  return { login, fetchCsrfToken, request, withCsrf, mintGuestToken };
}

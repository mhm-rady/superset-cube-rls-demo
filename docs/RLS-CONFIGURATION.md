# RLS Technical Configuration Reference

This document enumerates the concrete configuration required, layer by
layer, to make row-level security (RLS) actually enforce in this stack. It
is a checklist/reference, not a narrative — see `README.md`'s "Architecture"
section for *why* each piece exists and what was discovered while building
it.

Three layers cooperate. **Only two of them actually enforce anything**:

| Layer | Enforces RLS? | Role |
|---|---|---|
| Application (frontend/backend) | No | Establishes and hands over *identity* only |
| Superset | Partial (backstop) | Native RLS rule re-asserts identity; cannot itself restrict Cube-backed rows |
| Cube | **Yes** | `checkSqlAuth` + declarative `access_policy` do the actual row filtering |

If any single layer is misconfigured, the design goal is to fail closed
(reject the connection / return zero rows), never to fail open (return
unfiltered data). Each section below flags the settings that specifically
exist for that reason.

---

## 1. Application Layer (Frontend + Backend)

**Role:** mint a per-user identity and hand it to Superset. This layer
enforces nothing itself — a compromised or buggy frontend/backend must not
be able to *widen* what a persona can see, only fail to narrow it.

### Backend — `backend/`

Required environment variables (`.env`, consumed by `backend/server.js`):

| Variable | Purpose |
|---|---|
| `SUPERSET_INTERNAL_URL` | Where the backend logs in to Superset (compose-network address) |
| `SUPERSET_EMBED_DASHBOARD_UUID` | Dashboard the guest token is scoped to; written by `scripts/bootstrap.mjs` |
| `ADMIN_PASSWORD` | Superset admin credential the backend authenticates with to mint tokens |
| `CUBEJS_PG_SQL_PORT` / `CUBE_SQL_SHARED_PASSWORD` | Used only by `/api/explain`, which opens a direct per-persona connection to Cube's SQL API |
| `FRONTEND_ORIGIN` | The only origin the backend's CORS middleware allows |
| `BACKEND_PORT` | Listen port |

Required code configuration (`backend/server.js`, `backend/personas.js`,
`backend/supersetClient.js`):

1. `personas.json` is the single source of truth for `id -> territoryGroup`
   mapping. `backend/personas.js` reads it server-side; `listPersonas()`
   deliberately strips `territoryGroup` before returning persona data to the
   browser.
2. `POST /api/guest-token` accepts **only** a `personaId` from the browser
   body, resolves the full persona server-side, and mints the token with:
   - `username: persona.id` — must never be empty. Superset 4.1.3–6.1.0
     silently disables *all* guest RLS when `user.username` is falsy
     (`is_guest_user()` gates on it). `supersetClient.js`'s `mintGuestToken`
     throws if this is missing — do not remove that guard.
   - `resources: [{ type: 'dashboard', id: SUPERSET_EMBED_DASHBOARD_UUID }]`
   - `rls: [{ clause: "__user = '<persona.id>'" }]` for restricted personas;
     an empty array for the unrestricted admin persona (`territoryGroup ===
     '*'`), which has nothing to restrict.
3. CORS is scoped to `FRONTEND_ORIGIN` only, `GET,POST,OPTIONS`.
4. `mintGuestTokenWithRetry` discards the cached Superset admin session and
   re-authenticates once on a 401 — required because the login is cached
   for the process lifetime (`ensureSupersetLogin`), and a long-running
   backend will outlive Superset's own session expiry.

### Frontend — `frontend/`

1. `embedDashboard()` (`@superset-ui/embedded-sdk`) is wired with a
   `fetchGuestToken` callback that calls the backend **fresh on every
   persona switch** (`frontend/main.js`) — never a cached/reused token
   across personas.
2. The browser only ever sends a persona `id`; it has no code path that can
   construct or transmit a `territoryGroup` or SQL fragment.
3. Persona-switching UI is a convenience for the demo, not a security
   boundary — the actual boundary is enforced downstream (Superset RLS rule
   + Cube `access_policy`), by design.

---

## 2. Superset

**Role:** propagate the caller's identity into the connection Cube sees
(Layer 1, the load-bearing mechanism), plus a native RLS rule that
re-asserts identity as a backstop (Layer 2). Configured entirely through
`superset/superset_config_docker.py` (loaded via `SUPERSET_CONFIG_PATH`)
plus one-time provisioning via the REST API (`scripts/bootstrap.mjs`).

### `superset_config_docker.py` settings required

| Setting | Required value / behavior | Why |
|---|---|---|
| `FEATURE_FLAGS["EMBEDDED_SUPERSET"]` | `True` | Enables the embedded-dashboard + guest-token feature set |
| `FEATURE_FLAGS["ENABLE_TEMPLATE_PROCESSING"]` | `True` | Needed for the native RLS rule's Jinja clause (`{{ current_username() }}`) |
| `GUEST_ROLE_NAME` | `"Embedded"` (a dedicated role) | Must **not** be `"Public"` — Public's grants also apply to anonymous visitors |
| `GUEST_TOKEN_JWT_SECRET` | real secret, never the shipped default | 6.1.0 ships a public default with no startup guard |
| `GUEST_TOKEN_JWT_AUDIENCE` | pinned to `SUPERSET_PUBLIC_URL` | The auto-detected default can resolve to a bogus host (e.g. `http://0.0.0.0:8080/`) behind Gunicorn, which fails `aud` verification silently |
| `PREVENT_UNSAFE_DB_CONNECTIONS` | `False` | Only correct because Cube sits on a fully private compose network with no untrusted DNS — do not carry into a deployment where that isn't true |
| `DB_CONNECTION_MUTATOR` | see below | This *is* Layer 1 |
| `TALISMAN_CONFIG` **and** `TALISMAN_DEV_CONFIG` | both set to the same dict, `frame_options: None`, CSP `frame-ancestors` including `FRONTEND_ORIGIN` | Needed for the iframe to render at all. Superset's initializer picks `TALISMAN_DEV_CONFIG` whenever `app.debug`/`FLASK_DEBUG` is set — setting only `TALISMAN_CONFIG` has no effect in that mode |
| `CORS_OPTIONS` | `supports_credentials: True`, `origins` including `FRONTEND_ORIGIN` | Required for the embedded SDK's cross-origin calls |

`DB_CONNECTION_MUTATOR` requirements (this function *is* the enforcement
point for Layer 1):

- Fires on every SQLAlchemy engine Superset builds; must check host/port and
  touch **only** the Cube connection — every other database (notably
  Superset's own metadata Postgres) must pass through unchanged.
- Must rewrite the connection's username to the authenticated Superset
  user's `username` (the function argument, not
  `security_manager.current_user`, which raises when this mutator fires
  from a code path where `g.user` is unset).
- If `username` is falsy, must **not** fall back to any default identity —
  leave the connection's placeholder username in place so it reaches Cube
  as an identity `checkSqlAuth` rejects outright. Fail closed, not open.

### Provisioning-time configuration (via Superset's REST API)

These are metadata-store state, not `config.py` settings — they must exist
in Superset's database, created once by `scripts/bootstrap.mjs`:

1. **`Embedded` role** — cloned from the built-in `Gamma` role's permissions
   plus `all_datasource_access`. Verify (don't assume) that `Gamma` carries
   no SQL Lab permissions before cloning, since dataset-level RLS does not
   apply inside SQL Lab.
2. **Database connection to Cube** created with:
   - `impersonate_user: false` — identity propagation is handled entirely by
     `DB_CONNECTION_MUTATOR`; Superset's own impersonation must stay off so
     there is exactly one mechanism doing this job.
   - `expose_in_sqllab: false`, `allow_dml/ctas/cvas: false`.
3. **Dataset** created as a **physical** table dataset (no `sql=` field)
   pointed at the Cube view (e.g. `reseller_sales_view`). A virtual/SQL
   dataset wraps the query in a subquery and applies Superset's own RLS to
   the *outer* query instead — keep this in mind if converting to a virtual
   dataset later.
4. **Row Level Security rule** (`/api/v1/rowlevelsecurity/`): `filter_type:
   "Regular"`, `clause: "__user = '{{ current_username() }}'"`, scoped to
   the dataset and the `Embedded` role. This is Layer 2 — redundant with
   Layer 1 in the normal path, a hard-failure backstop when identity
   propagation misfires.
5. **Chart definitions** must set an explicit `query_context` (not just
   `params`) at creation time, reference metrics by name (string), not as
   inline ad-hoc metric objects, and — for table-type charts — set
   `orderby` to exactly what the viz type auto-generates. These aren't RLS
   settings per se, but a guest-token request that doesn't match is
   rejected by Superset's anti-tamper guard (`query_context_modified()`)
   before RLS is even relevant, so the dashboard fails to render.
6. **Embedding enabled** via `POST /api/v1/dashboard/{id}/embedded` with
   `allowed_domains: [FRONTEND_ORIGIN]`.

---

## 3. Cube

**Role:** the actual enforcement point. Identity arrives via the SQL API
connection's username (Layer 1) and/or an explicit `__user` filter (Layer
2); `access_policy` reads the resulting `securityContext` and injects the
mandatory row filter. All configuration lives in `cube/cube.js`,
`cube/model/cubes/*.yml`, and deployment env vars.

### `cube/cube.js` — identity layer

`checkSqlAuth(req, username, password)` must:

1. Look up `username` in `personas.json` and **reject any unrecognized
   username outright** (`throw`) — including whatever placeholder username
   is baked into Superset's stored database connection string. This is the
   fail-closed backstop: if `DB_CONNECTION_MUTATOR` ever fails to fire, the
   connection is refused, not silently unfiltered.
2. Validate `password` against `CUBE_SQL_SHARED_PASSWORD` **only when a
   password is present** — it is absent on `__user` switches and on Cube's
   periodic re-auth (`CUBESQL_AUTH_EXPIRE_SECS`, default 300s). Must not
   throw solely because password is missing on those paths.
3. Return a `securityContext` containing at least:
   - `territoryGroup` (the raw persona attribute the policy filters on)
   - `isUnrestricted` — a plain boolean computed **here, in JS**, not as a
     `== '*'` comparison inside the YAML policy. Cube's `access_policy`
     expression parser rejects `==`/`!=` comparisons outright (hard compile
     error); only boolean logic (`not`/`or`) and bare attribute truthiness
     are supported there.

`canSwitchSqlUser(current, next)` must return `true` **only** when `current
=== next`. This makes Layer 2's `__user` clause a no-op reassertion of the
identity already on the connection — never a real escalation path to a
different persona.

No `queryRewrite` hook is used for the row filter itself; the filter is
declared in the data model (below), which is Cube's documented mechanism
for row-level security and applies uniformly to every API surface Cube
exposes (SQL API, REST, GraphQL).

### `cube/model/cubes/*.yml` — declarative `access_policy`

On the fact cube being restricted (e.g. `reseller_sales`):

1. Define **two mutually exclusive, exhaustive** `access_policy` entries,
   both `group: "*"` (the documented "any group" shorthand — no real
   role/group hierarchy exists here):
   - `conditions: [{ if: "{ not securityContext.isUnrestricted }" }]` with a
     `row_level.filters` entry restricting a member to
     `securityContext.<attribute>`.
   - `conditions: [{ if: "{ securityContext.isUnrestricted }" }]` with **no**
     `row_level` block at all (the unrestricted/admin bypass).
2. The filtered member **must be local to the cube the policy is declared
   on** — `access_policy` filters cannot reference another cube's member
   (hard compile error: *"Paths aren't allowed in the accessPolicy
   policy..."*). If the attribute you need to filter on lives on a
   dimension table, add a local dimension computed via a correlated
   subquery (see `rls_territory_group` in
   `cube/model/cubes/reseller_sales.yml`) rather than pointing at the
   dimension cube directly.
   - Corollary: declaring the policy on the *dimension* cube instead (where
     the attribute is natively local) compiles, but silently filters
     nothing whenever a query doesn't need to join that dimension — the
     policy must live on the fact table the demo actually needs to
     restrict.
3. Single-brace expression syntax (`{ securityContext.x }`) is a distinct,
   later-stage mechanism from the double-brace Jinja templating used
   elsewhere in the same file (e.g. Superset's RLS clause) — do not
   conflate them, and do not write literal `{{ }}` inside YAML comments in
   this file; the entire file (comments included) is run through Cube's
   Jinja preprocessor before being parsed as YAML.
4. Define no `pre_aggregations` on any RLS-restricted cube. Cube's refresh
   worker builds pre-aggregations with an undefined security context, so a
   pre-aggregation here would build unfiltered data.

### Required deployment / environment configuration

| Variable / setting | Required value | Why |
|---|---|---|
| `CUBEJS_DEV_MODE` | `"false"` | **Mandatory.** `access_policy` row-level enforcement is a complete, undocumented no-op under dev mode — confirmed via trace comparison, not just member-level access control as Cube's docs state |
| Cube Store | a real external `cubestore` service, healthy before `cube` starts | Dev mode's embedded Cube Store no longer applies once `CUBEJS_DEV_MODE=false`; the SQL API needs one regardless of whether pre-aggregations are used |
| `CUBEJS_API_SECRET` | real secret | Cube's own token signing |
| `CUBEJS_DB_TYPE` / `CUBEJS_DB_HOST` / `CUBEJS_DB_PORT` / `CUBEJS_DB_NAME` / `CUBEJS_DB_USER` / `CUBEJS_DB_PASS` | warehouse connection | Underlying data source credentials |
| `CUBEJS_PG_SQL_PORT` | explicit value | No built-in default — omitting it silently disables the SQL API entirely rather than falling back to a conventional port |
| `CUBE_SQL_SHARED_PASSWORD` | one shared secret for every persona's SQL API connection | Safe specifically because identity travels in the connection **username** (validated in `checkSqlAuth` against `personas.json`), not in this password — it only proves the connection came from this project's own Superset/backend |

---

## Cross-layer invariants

These properties must hold **across** the three layers for RLS to actually
enforce; a change in any one layer can silently break them:

- **`personas.json` is the only place `id -> territoryGroup` mapping is
  defined.** Both `backend/personas.js` and `cube/cube.js` load the same
  file (mounted read-only into both containers). The browser never sees or
  sends a `territoryGroup`.
- **Identity is carried in the SQL API connection's username, validated
  server-side against a known persona list, not trusted from a password or
  client-supplied claim.** The one shared `CUBE_SQL_SHARED_PASSWORD` only
  authenticates "this connection came from our stack," never "this
  connection is entitled to persona X's data."
- **An unrecognized identity is always rejected, never passed through with
  a default/unrestricted scope** — enforced independently at three points:
  `checkSqlAuth` (unknown username), `canSwitchSqlUser` (identity mismatch
  on `__user`), and `DB_CONNECTION_MUTATOR` (empty username leaves the
  placeholder identity in place rather than defaulting to something
  scoped).
- **`CUBEJS_DEV_MODE` must stay `false`** for as long as RLS is expressed as
  a declarative `access_policy` — this is easy to regress by copying a
  quickstart `docker-compose.yml` that uses dev mode for convenience.

## Verification

- `node scripts/bootstrap.mjs` runs two automated checks after
  provisioning: a Cube-only smoke test (bypasses Superset, exercises
  `checkSqlAuth` + `access_policy` directly) and a full-stack smoke test
  (real guest token → real Superset chart-data call → real Cube query),
  both asserted against `personas.json`'s `expectedTotal` per persona.
- The frontend's "Run EXPLAIN" button (`GET /api/explain/:personaId` in
  `backend/server.js`) opens a direct per-persona connection to Cube and
  runs `EXPLAIN`, surfacing the compiled filter for manual inspection.
- `docker compose logs cube` at `CUBEJS_LOG_LEVEL=trace` shows the literal
  T-SQL Cube sends to the warehouse, including the injected `WHERE` clause
  — the most direct confirmation that a given persona's query was actually
  filtered, not just accepted.

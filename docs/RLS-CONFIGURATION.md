# RLS Configuration Reference: Superset + Cube

This document is a deployment-agnostic checklist/reference for propagating
per-end-user identity from Apache Superset into Cube's SQL API so that
**Cube — not Superset — enforces row-level security (RLS)**. It is
distilled from a working, automated-tested reference implementation (this
repository — see `README.md` for the concrete instance, real trace output,
and the specific bugs found while building it). Use this document when
adapting the same pattern to a *different* deployment: a different
warehouse behind Cube, a different identity model, or a Superset install
that isn't embedded at all.

Three layers cooperate. **Only two of them actually enforce anything**:

| Layer | Enforces RLS? | Role |
|---|---|---|
| Application (whatever mints/establishes identity) | No | Establishes and hands over *identity* only |
| Superset | Partial (backstop) | Native RLS rule re-asserts identity; cannot itself restrict Cube-backed rows |
| Cube | **Yes** | `checkSqlAuth` + declarative `access_policy` do the actual row filtering |

If any single layer is misconfigured, the design goal is to **fail closed**
(reject the connection / return zero rows), never to fail open (return
unfiltered data). Each section below flags the settings that specifically
exist for that reason.

This works because of one structural fact worth stating up front: **Cube's
SQL API always speaks the Postgres wire protocol**, regardless of what
warehouse sits behind Cube (`CUBEJS_DB_TYPE` can be Postgres, MySQL, SQL
Server, Snowflake, BigQuery, etc.). So from Superset's side, the connection
to Cube is *always* a `postgresql+psycopg2://`-style SQLAlchemy connection,
no matter what your actual data source is. Everything in the "Superset"
section below follows from that.

---

## Two identity-handover patterns this applies to

The same three-layer design supports either (or both) of these; they only
differ in how "the current user's identity" gets established before it
reaches Layer 1:

1. **Embedded / guest-token dashboards.** An external application
   authenticates its own users, then asks Superset's REST API for a guest
   token scoped to one identity (`user.username` in the token payload).
   Requires `FEATURE_FLAGS["EMBEDDED_SUPERSET"]`, a dedicated guest role,
   and the `GUEST_TOKEN_*` settings below.
2. **Direct/native Superset login.** Real users log into Superset itself
   (DB auth, LDAP, OAuth, SAML, whatever `AUTH_TYPE` you run). Identity is
   just the logged-in Superset user's `username` — no guest token involved.

Layers 1–3 below are written generically enough to cover both; settings
that apply to *only* the embedded pattern are marked **(embedding only)**.
Both patterns converge on the same fact: Superset's Jinja macro
`{{ current_username() }}` resolves correctly for a guest user *and* a
directly logged-in user, which is what lets the Layer 2 backstop rule below
be identical in either case.

---

## 1. Application Layer (identity minting)

**Role:** establish a per-user identity and get it in front of Superset.
This layer enforces nothing itself — a compromised or buggy caller must
not be able to *widen* what an identity can see, only fail to narrow it.

Requirements, regardless of pattern:

1. Maintain a single, authoritative source of truth for
   `identity -> attribute(s)` (territory, tenant id, business unit,
   region, cost center — whatever your row filter actually keys on). Every
   layer that needs to resolve an identity to its attributes reads *this
   one place* — a shared file, a database table, an external IdP's claims,
   whatever fits your stack. Do not let more than one copy of this mapping
   exist.
2. **The caller (browser, mobile app, upstream service) only ever
   transmits an opaque identity key** — a user id, tenant id, or persona
   id. It must have no code path that can construct or transmit the actual
   filter value or a SQL fragment. Attribute resolution happens
   server-side, downstream (in Cube's `checkSqlAuth`, below) — never
   client-side.
3. **(Embedding only)** When minting a guest token:
   - `user.username` must be non-empty. Superset 4.1.3–6.1.0 silently
     disables *all* guest RLS when it's falsy (`is_guest_user()` gates on
     it) — no error, just unfiltered access. Guard against this explicitly
     at mint time.
   - Build the `rls` clause (and any `resources` scoping) through a typed
     helper, not hand-assembled JSON. Superset's guest-token `rls` schema
     is permissive enough that a keying typo (e.g. `datasource` instead of
     `dataset`) silently becomes a *broader* rule instead of failing — a
     realistic way to accidentally fail open.
   - Fetch a fresh token on every identity switch; never cache/reuse one
     token across different identities.
   - If the process minting tokens is long-running (a service, not a
     script), make sure its own login to Superset's API is refreshed on
     expiry (401), not cached for the process lifetime — an easy way to
     get an intermittent, hard-to-reproduce failure in production that
     never shows up in a short-lived test run.
4. **(Direct login)** Nothing extra is required here beyond normal
   Superset auth configuration (`AUTH_TYPE`, your identity provider) —
   Layer 2 reads `g.user.username`/`current_username()` the same way it
   would for a guest user.

---

## 2. Superset

**Role:** propagate the caller's identity into the connection Cube sees
(Layer 1 of the *enforcement* design — the load-bearing mechanism), plus a
native RLS rule that re-asserts identity as a backstop (Layer 2 of
enforcement). Configured through Superset's `config.py` (or equivalent)
plus one-time provisioning via the REST API or UI.

### Settings

| Setting | Required value / behavior | Applies to | Why |
|---|---|---|---|
| `FEATURE_FLAGS["EMBEDDED_SUPERSET"]` | `True` | embedding only | Enables the embedded-dashboard + guest-token feature set |
| `FEATURE_FLAGS["ENABLE_TEMPLATE_PROCESSING"]` | `True` | both | Needed for the native RLS rule's Jinja clause (`{{ current_username() }}`) |
| `GUEST_ROLE_NAME` | a dedicated role, **not** `"Public"` | embedding only | Public's grants also apply to anonymous, unauthenticated visitors |
| `GUEST_TOKEN_JWT_SECRET` | a real secret | embedding only | Never ship a default here |
| `GUEST_TOKEN_JWT_AUDIENCE` | pinned to the public-facing Superset URL | embedding only | The auto-detected default can resolve to whatever host Superset sees behind your proxy/load balancer, which is frequently *not* the URL the browser presents the token to — a mismatched `aud` fails verification silently |
| `PREVENT_UNSAFE_DB_CONNECTIONS` | `False`, **only if** Superset's network path to Cube is fully trusted | both | Superset's SSRF guard blocks SQLAlchemy connections resolving to a private/link-local IP range by default — which is exactly where an internal Cube service usually lives. Do not disable this if any part of that network path is not fully trusted |
| CORS / CSP / frame-ancestors (Talisman) | scoped to your embedding origin(s), `frame_options: None` | embedding only | Needed for the iframe to render and for the embedded SDK's cross-origin calls. Note: some Superset versions pick a *separate* dev-mode Talisman config whenever debug mode is on — verify your live response headers, don't assume one config variable governs both modes |

### Identity propagation: fixed connection identity + `__user` switch

Superset's stored database connection to Cube authenticates as **one
fixed, non-privileged identity** — never a per-request rewrite of the
connection's username. That identity must be a real, recognized entry in
whatever identity list `checkSqlAuth` (below) validates against, scoped to
**zero access by default** (e.g. an attribute value no real identity ever
has). Per-request scoping then happens entirely through Cube's documented
`__user = '<identity>'` virtual filter, emitted by the guest token's `rls`
clause and/or a native Superset RLS rule (below), which Cube's
`canSwitchSqlUser` authorizes only when the connection's *current* identity
is that fixed one — see the Cube section for the authorization rule itself.

This deliberately does **not** use `DB_CONNECTION_MUTATOR`, Superset's hook
for rewriting a SQLAlchemy connection's username per request (fires on
every engine Superset creates; would need to check host/port and touch
only the Cube connection). That hook is a legitimate alternative identity-
propagation mechanism — one where the connection's own username *is* the
per-user identity, and no switch is ever needed — but the two approaches
are mutually exclusive: pick one. The fixed-identity-plus-switch approach
documented here trades that simplicity for less connection-pool churn (one
connection identity instead of one per end user) and for putting the
entire per-request enforcement into one auditable authorization rule
(`canSwitchSqlUser`) instead of a URL rewrite hook. If you'd rather rewrite
the connection's username directly and skip `__user` switching entirely,
mirror `DB_CONNECTION_MUTATOR`'s shape from Superset's own docs: check
host/port, use the `username` function argument (never
`security_manager.current_user`, which can raise depending on the call
path), and leave the connection's placeholder identity in place on a falsy
`username` rather than substituting a default, so "no identity" still
fails closed. Superset's built-in `impersonate_user` checkbox is not a
substitute for either approach on Cube's connection specifically — it's
only officially implemented for a handful of engine specs (Hive, Presto,
Trino, Drill, GSheets, partial Snowflake as of Superset 6.x), and Cube's
SQL API is always Postgres-wire, so that checkbox falls through to a
deprecated legacy fallback rather than a maintained feature for this
engine.

### Provisioning-time configuration

These are metadata-store state, not `config.py` settings — provision them
once (via the REST API, a setup script, or the UI):

1. **A role for RLS-scoped users** — for embedding, a dedicated role (not
   `Gamma` or `Public` directly); for direct login, whatever role(s) your
   real users hold. Either way, verify — don't assume — that the role
   carries no SQL Lab permissions (`menu_access on SQL Lab`,
   `can_sql_json`, etc.): **dataset-level RLS does not apply inside SQL
   Lab**, so any role that can reach it bypasses this entire design.
2. **Database connection to Cube**, created with:
   - `impersonate_user: false` — not a substitute for either identity-
     propagation mechanism on this connection (see above); leave it off
     regardless of which one you use.
   - `expose_in_sqllab: false`, DML/CTAS/CVAS disabled, for the same
     reason as (1).
3. **Dataset created as a physical table dataset** (no `sql=` field)
   pointed at a Cube cube or view. A virtual/SQL dataset wraps the query in
   a subquery and applies Superset's own RLS to the *outer* query instead
   — worth knowing before converting one later.
4. **Row Level Security rule** (`filter_type: "Regular"`,
   `clause: "__user = '{{ current_username() }}'"`, scoped to the dataset
   and the RLS-scoped role(s)). Under the fixed-connection-identity pattern
   above, this rule **is** the per-request enforcement mechanism, not a
   backstop — without it, a query on this connection runs as the fixed
   identity's own zero-access default. `current_username()` resolves
   correctly for both a guest user and a directly logged-in user, so this
   one rule covers either pattern. (If you instead chose the
   `DB_CONNECTION_MUTATOR` alternative, this rule reverts to being a
   redundant, defense-in-depth backstop — see its comment there.)
5. **Chart definitions must set an explicit `query_context`** (not just
   `params`) at creation time, reference metrics by name (string) rather
   than as inline ad-hoc metric objects, and — for table-type charts — set
   `orderby` to exactly what the viz type auto-generates. These aren't RLS
   settings per se, but a request that doesn't match the chart's saved
   shape is rejected by Superset's anti-tamper guard
   (`query_context_modified()`) before RLS is even relevant, so the
   dashboard simply fails to render.
6. **(Embedding only)** Enable embedding on the dashboard, scoped to your
   allowed origin(s).

---

## 3. Cube

**Role:** the actual enforcement point. Identity arrives via the SQL API
connection's username and/or an explicit `__user` filter switch;
`access_policy` reads the resulting `securityContext` and injects the
mandatory row filter. Under the fixed-connection-identity pattern (§2
above), every real request's identity arrives via the `__user` switch —
the connection's own username is always the fixed identity, restricted to
zero access by default.

### `cube.js` — identity layer

```js
// The one identity Superset's stored connection authenticates as -- not a
// real end user, and scoped to zero access in lookupIdentity's own data
// (see §2's fixed-connection-identity pattern).
const CONNECTION_IDENTITY = 'superset_connection';

module.exports = {
  checkSqlAuth: (req, userName, password) => {
    const identity = lookupIdentity(userName); // your id -> attribute(s) mapping
    if (!identity) {
      // Reject any unrecognized username outright. Covers the fixed
      // connection identity failing to resolve (misconfiguration) and any
      // __user switch to a nonexistent identity -- both fail closed here.
      throw new Error('Access denied');
    }

    // `password` is provided only on a NEW connection; it is absent on
    // __user switches (Cube calls this function again for the target
    // username before invoking canSwitchSqlUser below) and on Cube's
    // periodic re-auth (CUBESQL_AUTH_EXPIRE_SECS, default 300s). Do not
    // throw solely because password is missing on those paths.
    if (password != null && password !== SHARED_SQL_API_PASSWORD) {
      throw new Error('Access denied');
    }

    return {
      password,
      securityContext: {
        username: identity.id,
        // Whatever attribute(s) your row filter keys on:
        scopeAttribute: identity.scopeAttribute,
        // Compute booleans HERE, in real JS -- access_policy's expression
        // parser rejects `==`/`!=` comparisons outright, so any comparison
        // must already be a boolean fact by the time the policy sees it.
        isUnrestricted: identity.scopeAttribute === '*',
      },
    };
  },

  // The entire per-request scoping mechanism under the fixed-connection-
  // identity pattern: a switch is authorized only when the connection's
  // CURRENT identity is the fixed one. `next` doesn't need re-validating
  // here -- checkSqlAuth already ran for it above and would have thrown on
  // an unrecognized identity. A real identity is never allowed to switch
  // to a DIFFERENT real identity (or to the fixed identity itself) -- only
  // the no-op self-reassertion (current === next) both the guest-token
  // flow and periodic re-auth rely on. That turns any mismatch (e.g. a
  // connection-pool bug handing a request the wrong cached connection)
  // into a hard query failure instead of a silent cross-tenant data leak.
  //
  // If you instead chose the DB_CONNECTION_MUTATOR alternative (§2) and
  // never need real switching, use `current === next` unconditionally.
  canSwitchSqlUser: (current, next) => current === next || current === CONNECTION_IDENTITY,

  // No queryRewrite needed for the row filter itself -- see access_policy
  // below, Cube's documented mechanism for row-level security.
};
```

Requirements:

1. Reject any unrecognized `username` outright (`throw`) — including the
   fixed connection identity itself if it's ever misconfigured, and any
   `__user` switch target that isn't a real identity.
2. Validate the shared secret **only when a password is present** (absent
   on `__user` switches and periodic re-auth) — do not throw solely
   because it's missing on those paths.
3. Return a `securityContext` with whatever raw attribute(s) your filter
   needs, plus any boolean facts computed in JS rather than as `==`/`!=`
   comparisons in the YAML policy (unsupported there — see below).
4. `canSwitchSqlUser(current, next)` should return `true` for
   `current === next` always, plus — only under the fixed-connection-
   identity pattern — `current === <the fixed connection identity>`.
   Never authorize a switch between two different real identities.

**Identity source alternative:** the pattern above authenticates the SQL
API connection by username + one shared password, with identity carried
entirely in the *username* (validated server-side against a known
identity list) — safe because the password only proves "this connection
came from our own trusted service," never "this connection is entitled to
identity X's data." If your deployment already has a signed-JWT identity
(from an upstream IdP, or from Superset's own guest-token JWT reused
directly), Cube's SQL API also supports authenticating via a JWT passed
through `checkSqlAuth`'s `req` — consider that instead of a shared
password if you want per-connection cryptographic proof of identity rather
than a shared secret plus a trusted network boundary.

### `model/**/*.yml` — declarative `access_policy`

```yaml
cubes:
  - name: your_fact_table
    sql_table: your_schema.YourFactTable

    access_policy:
      - group: "*"
        conditions:
          - if: "{ not securityContext.isUnrestricted }"
        row_level:
          filters:
            - member: rls_scope_attribute
              operator: equals
              values: [ "{ securityContext.scopeAttribute }" ]

      # Unrestricted/admin bypass: no row_level block means this entry
      # contributes no filter at all.
      - group: "*"
        conditions:
          - if: "{ securityContext.isUnrestricted }"

    dimensions:
      # Exists only for access_policy to filter on. If the attribute lives
      # on a joined dimension table rather than natively on this cube, add
      # it as a LOCAL dimension via a correlated subquery -- see
      # constraint 1 below for why a direct cross-cube reference won't
      # compile.
      - name: rls_scope_attribute
        sql: "(SELECT d.ScopeAttribute FROM your_schema.YourDimTable d WHERE d.Key = {CUBE}.Key)"
        type: string
        public: false
```

Requirements, and two hard constraints that are easy to lose hours to:

1. Define **two mutually exclusive, exhaustive** `access_policy` entries,
   both `group: "*"` (the documented "any group" shorthand — use this
   unless you have a real role/group hierarchy and a `contextToRoles`
   equivalent; note that mechanism was removed in Cube 1.7.0, so recent
   Cube Core deployments key off `securityContext` directly rather than
   Cube Cloud's `userAttributes`/role-derivation docs).
2. **`access_policy` filters cannot reference another cube's member** —
   a filter pointing at a joined cube's member is a hard compile error
   ("Paths aren't allowed in the accessPolicy policy..."). If the
   attribute you need lives on a dimension table, add a local dimension
   computed via a correlated subquery on the fact cube instead (as above),
   rather than pointing at the dimension cube directly.
   - Corollary: declaring the policy on the *dimension* cube instead
     (where the attribute is natively local) compiles fine but silently
     filters nothing whenever a query doesn't need to join that dimension
     — the optimizer correctly drops joins nothing needs, and a row-level
     policy on a table nothing joins to has nothing to restrict. The
     policy must live on the fact table you actually need to restrict.
3. Single-brace expression syntax (`{ securityContext.x }`) is a distinct,
   later-stage mechanism from double-brace Jinja templating used elsewhere
   in the same file (e.g. Superset's RLS clause). Cube runs the **entire**
   YAML file — comments included — through its Jinja preprocessor before
   parsing it as YAML, so avoid writing literal `{{ }}` anywhere in the
   file, comments included.
4. Define **no `pre_aggregations`** on any RLS-restricted cube. Cube's
   refresh worker builds pre-aggregations with an undefined security
   context, so a naive pre-aggregation would build unfiltered data. If you
   need pre-aggregations on RLS-restricted data, you must keep
   `scheduledRefreshContexts` in lockstep with every identity's attributes
   yourself — there is no automatic way around this tension, imperative or
   declarative.
5. **`CUBEJS_DEV_MODE` must be `"false"`.** `access_policy` row-level
   enforcement is a complete, undocumented no-op under dev mode — not just
   the member-level access control Cube's docs describe. This is easy to
   regress by copying a quickstart `docker-compose.yml` that leaves dev
   mode on for convenience. Production mode requires a real external Cube
   Store (dev mode's embedded one no longer applies), regardless of
   whether you use pre-aggregations.

### Required deployment / environment configuration

| Variable / setting | Required value | Why |
|---|---|---|
| `CUBEJS_DEV_MODE` | `"false"` | Mandatory — see constraint 5 above |
| Cube Store | a real external service, healthy before Cube starts | Required once dev mode is off, independent of whether pre-aggregations are used |
| `CUBEJS_API_SECRET` | real secret | Cube's own token signing |
| `CUBEJS_DB_TYPE` / host / port / name / user / pass | your warehouse connection | Works the same regardless of which warehouse — check that driver's own quirks (e.g. some drivers ignore the generic `CUBEJS_DB_SSL_*` variables and require a driver-specific encryption flag instead) |
| `CUBEJS_PG_SQL_PORT` | explicit value | No built-in default on some Cube versions — omitting it can silently disable the SQL API entirely rather than falling back to a conventional port |
| SQL API shared secret | one shared secret authenticating "this connection came from our trusted stack" | See identity-source note above; identity itself must never be trusted from this value |

---

## Cross-layer invariants

These properties must hold **across** all three layers for RLS to actually
enforce; a change in any one layer can silently break them:

- **Exactly one place defines the `identity -> attribute(s)` mapping**,
  and every layer that needs to resolve one reads that same source.
  Callers (browser, external app) never see or send the actual attribute
  value — only an opaque identity key.
- **Identity is carried in the SQL API connection's username, validated
  server-side against a known identity list** — not trusted from a
  password or a client-supplied claim (unless you've deliberately adopted
  the JWT-based alternative above, in which case identity is validated via
  signature instead).
- **An unrecognized identity is always rejected, never passed through with
  a default/unrestricted scope** — enforce this independently at every
  point that could see one: `checkSqlAuth` (unknown username),
  `canSwitchSqlUser` (identity mismatch on `__user`), and — whichever
  identity-propagation mechanism you chose (§2) — either the fixed
  connection identity's own zero-access attribute value, or
  `DB_CONNECTION_MUTATOR` leaving the placeholder identity in place on a
  falsy username rather than defaulting to something scoped.
- **`CUBEJS_DEV_MODE` stays `false`** for as long as RLS is expressed as a
  declarative `access_policy`.

---

## Adapting this reference to a new deployment

Concrete decisions to make before reusing this pattern elsewhere:

1. **Which identity-handover pattern(s)?** Embedded/guest-token, direct
   login, or both — determines whether the `GUEST_TOKEN_*`/embedding
   settings apply at all.
2. **What's the attribute model?** A single flat attribute (as above) is
   the simple case. Multiple attributes, hierarchical roles, or
   many-to-many group membership all still fit the same `securityContext`
   + `access_policy` shape, but the `if` conditions and filter values get
   more involved — keep any real comparison logic in `checkSqlAuth` (JS),
   not in the YAML expression language, since it only supports boolean
   logic and bare truthiness.
3. **What warehouse sits behind Cube?** Confirm `CUBEJS_DB_TYPE` support
   and that driver's specific connection/encryption options — don't assume
   the generic `CUBEJS_DB_*` variables are honored uniformly across
   drivers.
4. **Do you need pre-aggregations on RLS-restricted data?** If yes, plan
   `scheduledRefreshContexts` alongside your identity list from day one —
   retrofitting it later is real, deferred work, not a config toggle.
5. **Is Superset's network path to Cube fully trusted?** Governs whether
   `PREVENT_UNSAFE_DB_CONNECTIONS: False` is actually safe to set — it is
   only correct on a network with no untrusted DNS/routing between the two.
6. **Do any Superset roles that reach these datasets also have SQL Lab
   access?** If so, dataset-level RLS is not your actual enforcement
   boundary for those roles — either remove SQL Lab access or treat Cube's
   `access_policy` as the only enforcement you can rely on.

## Verification approach

Whatever the deployment, build two automated checks analogous to what this
reference implementation runs on every provisioning pass:

1. **A Cube-only smoke test** that bypasses Superset entirely — open a
   direct SQL API connection as each identity you care about and assert
   the row-filtered result, exercising `checkSqlAuth` + `access_policy`
   directly.
2. **A full-stack smoke test** that goes through the real path end to end
   (mint a real token or log in as a real user → real Superset chart-data
   call → real Cube query) and asserts the same expected results.

Both should be checked against known-good expected values per identity,
not just "did it return without erroring" — an unfiltered result and a
correctly filtered result both return HTTP 200. Also verify the *failure*
paths directly, not just the success paths: an unrecognized identity
should be refused, and a `__user` switch to a different identity than the
one on the connection should fail loudly rather than silently.

# Superset + Cube + SQL Server — Row-Level Security Demo

A working demonstration of an embedded Apache Superset dashboard backed by
Cube (the semantic layer) over a containerized SQL Server warehouse
(`AdventureWorksDW`), where **a user's data scope is enforced at every hop**
— not just at the web app, and not just by trusting Superset.

**Verified end-to-end, for real** — this isn't aspirational. Every number
below was produced by actually running the stack:

| Persona | Territory scope | Dashboard total |
|---|---|---:|
| Alice Nakamura | North America | $67,985,726.81 |
| Bob Okafor | Europe | $10,870,534.80 |
| Carol Nguyen | Pacific | $1,594,335.38 |
| Dana Petrov (admin) | *(unrestricted)* | $80,450,596.98 |

`node scripts/bootstrap.mjs` reproduces this itself on every run: it mints a
real guest token for each persona through the backend, calls Superset's
guest-token-authenticated chart-data API with it, and asserts the returned
total against the table above. If you see `PASS` four times over, you're
looking at the real thing, not a claim.

## Why this is harder than it looks

The obvious version of this architecture doesn't actually work. Superset
connects to Cube's SQL API as a single pooled service account, so by
default Cube sees one identity for every end user and can enforce nothing.
Cube's own Superset documentation stops at "connect to Cube as to a
Postgres database" and never mentions a security context; its blog
walkthrough uses one hardcoded account. The shipped-reality baseline for
this stack is *Superset enforces row-level security, Cube trusts Superset
completely* — a single point of failure.

This demo does better, with **two independent enforcement layers**, and
this README is explicit about which parts are genuine enforcement and
which are cooperative filtering.

## Architecture

```
Browser ──1── Express backend ──2── Superset API (mint guest token)
   │                                      │
   └──3── Superset embedded iframe ───────┘
                  │
                  4  SQL over Postgres wire, connection username
                  │  rewritten per end user by DB_CONNECTION_MUTATOR
                  ▼
              Cube SQL API ──5── check_sql_auth → securityContext
                  │              access_policy (declarative) → mandatory filter
                  ▼
              SQL Server (T-SQL with WHERE SalesTerritoryGroup = …)
```

1. The browser asks the backend for a guest token for the selected persona.
2. The backend authenticates to Superset and mints a guest token scoped to
   that persona's identity (`backend/server.js`, `backend/supersetClient.js`).
3. The browser hands that token to `@superset-ui/embedded-sdk`, which loads
   the dashboard in an iframe pointed directly at Superset (`frontend/main.js`).
4. Every query the dashboard issues goes to Cube's Postgres-wire SQL API.
   Superset's `DB_CONNECTION_MUTATOR` (**Layer 1**) rewrites the connection
   username to the current persona's id *before the connection opens* —
   this is what lets Cube see a real per-user identity at all.
5. Cube's `check_sql_auth` (`cube/cube.js`) maps that username to a
   `securityContext`, and the `reseller_sales` cube's declarative
   `access_policy` (`cube/model/cubes/reseller_sales.yml`) reads it and
   injects the mandatory territory filter — Cube's own documented,
   recommended way to do row-level security, not a hand-rolled
   `query_rewrite` hook. Confirmed by reading Cube's own trace logs (`CUBEJS_LOG_LEVEL=trace`)
   during a live run — the actual T-SQL sent to SQL Server for Alice reads:
   ```sql
   SELECT TOP 50000 sum("reseller_sales".SalesAmount) "reseller_sales_view__total_sales_amount"
   FROM dbo.FactResellerSales AS "reseller_sales"
   LEFT JOIN dbo.DimSalesTerritory AS "sales_territory"
     ON "reseller_sales".SalesTerritoryKey = "sales_territory".SalesTerritoryKey
   WHERE ("sales_territory".SalesTerritoryGroup = @_1)
   ```
   Cube enforces this itself and cannot be talked out of it by the client.

**Layer 2** — the guest token also carries an `rls` clause using Cube's
documented `__user` virtual filter (`__user = '<persona>'`).
`can_switch_sql_user` in `cube/cube.js` only allows this to be a **no-op
reassertion** of the identity Layer 1 already established — never a real
switch to a different identity. Verified directly: opening a connection as
`alice` and requesting `WHERE __user = 'bob'` fails with *"You cannot
change security context via __user from alice to bob, because it's not
allowed."* In the normal path this is redundant with Layer 1; its value is
in the failure path — a connection-pool bug or misconfiguration that hands
a request the wrong identity becomes a **hard query error**, not a silent
cross-tenant leak.

### Why the filter is declarative, not a `queryRewrite` hook

The territory filter used to be injected imperatively, from a `queryRewrite`
function in `cube/cube.js`. It now lives in
`cube/model/cubes/reseller_sales.yml`, as a declarative `access_policy` —
Cube's own documented mechanism for row-level security
(docs.cube.dev/docs/data-modeling/access-control/row-level-security), not a
workaround. Three concrete reasons this is the better fit here, not just a
style preference:

- **It reads as policy next to the data it restricts**, not as a string
  assembled in JS three files away from the dimension it names.
- **It applies to any API surface Cube exposes** (SQL API, REST, GraphQL)
  uniformly, since it's evaluated by Cube's query engine itself — a
  `queryRewrite` hook only ever fires for the code path that calls it.
- **It's no longer coupled to the view's name.** The old filter pushed a
  fully-qualified member path, `reseller_sales_view.territory_group`; renaming
  that view would have silently stopped it from matching anything. The
  `access_policy` lives on the `reseller_sales` cube itself, the fact table
  the demo actually needs to restrict, so it survives any view rename.

Two things worth being precise about, since Cube Core's docs mostly show
Cube Cloud's `userAttributes`, not `securityContext`, and use a `group`/role
model this demo doesn't need:

- The docs' examples key off `userAttributes` (Cube Cloud only). This
  project has no Cube Cloud subscription and no `contextToRoles` (removed in
  Cube 1.7.0 — see "Version pins and traps avoided"), so every filter and
  condition here reads `securityContext` directly instead, exactly as the
  docs note is the Core-deployment equivalent.
- Every policy entry below uses `group: "*"` — the documented "any group"
  shorthand — because this demo has no group/role hierarchy, only a flat
  `securityContext.territoryGroup` value per persona. Tried adding a
  `contextToGroups` config anyway just to be sure it wasn't silently
  required; made no measurable difference, so it was left out. The admin
  bypass (territoryGroup `'*'`) is expressed as a second, mutually-exclusive
  `access_policy` entry rather than an early return, so the two entries
  together are exhaustive over every value that field can take and there is
  never a state where group `"*"` matched but no entry's `conditions` held.

#### Two hard constraints, found live, not by reading a changelog

Getting from "compiles" to "actually filters" took real investigation —
both of these turned what looked like a five-minute migration into hours of
comparing traces:

1. **`access_policy` filters cannot reference another cube's member.** The
   first attempt put the policy on `sales_territory` (where `territory_group`
   actually lives) and filtered `member: territory_group` there directly.
   It compiled and looked right, but every persona still got the unfiltered
   grand total — trace logs showed **zero `JOIN` to `DimSalesTerritory` and
   an empty `filters: []`** at every planning stage. The reason: a query for
   `reseller_sales`'s own `total_sales_amount` never needs to join
   `sales_territory` at all, so Cube's optimizer correctly drops the join —
   and a row-level policy on a table nothing joins to has nothing to
   restrict. This is exactly how native SQL-database row-level security
   behaves too (a predicate on a table your query never touches is a no-op,
   not an error), and Cube's own docs say row-level security here is
   "similar to row-level security in SQL databases" — this project just
   hadn't internalized what that similarity implies until hitting it.
   Pointing the filter at the fact table directly (`member:
   sales_territory.territory_group`, a cross-cube path) doesn't work around
   it either — that's a **hard compile error**: *"Paths aren't allowed in
   the accessPolicy policy but 'sales_territory.territory_group' provided
   as a filter member reference for reseller_sales."* The fix:
   `reseller_sales.yml` now has its own local `rls_territory_group`
   dimension, computed with a correlated scalar subquery that reaches
   `DimSalesTerritory` without ever being a cross-cube reference at the
   `access_policy` layer.
2. **`access_policy` is a complete no-op under `CUBEJS_DEV_MODE=true`.**
   Cube's own docs only document dev mode as disabling *member-level*
   access control. Row-level enforcement turned out to be silently inert
   under it too — undocumented, found by running the identical query
   through dev mode and production mode side by side and diffing the
   traces: dev mode always showed `filters: []` and the unfiltered total,
   regardless of how the policy was written; switching `CUBEJS_DEV_MODE` to
   `"false"` (with a real external Cube Store attached — dev mode's
   embedded one no longer applies) produced the correct per-persona totals
   immediately, with no other change. `docker-compose.yml` now runs a
   `cubestore` service and `cube` in production mode because of this,
   which is real added infrastructure this migration cost the project —
   worth knowing before choosing `access_policy` over `queryRewrite` for a
   dev-mode-only setup.

Also worth knowing up front: Cube's own SQL API security documentation
(`docs.cube.dev/reference/core-data-apis/sql-api/security`) documents
`queryRewrite`, Twig/Jinja-based masking, and the `__user` virtual filter as
the SQL-API-specific mechanisms — it never mentions `access_policy` at all.
That's consistent with what was found here; it just doesn't say so as
directly as the two failures above demonstrated.

### The honest boundary

Superset's dataset-level RLS does not apply inside **SQL Lab**. The
`Embedded` role therefore has no SQL Lab query access — but see "Discovered
during verification" below for one real nuance this project found, not
assumed, about that guarantee.

## Data source

`AdventureWorksDW` runs in its own container (`mssql` service), restored
from a `.bak` produced from a real local SQL Server instance — not
downloaded from the internet, and not the original design (which connected
to a local instance directly; that needed a static TCP port, a firewall
rule, and an elevated PowerShell session, none of which a container needs).

If `mssql/backup/AdventureWorksDW.bak` is missing (it's gitignored — a
21MB binary data dump doesn't belong in source control), reproduce it from
any SQL Server instance that already has `AdventureWorksDW` restored:

```sql
BACKUP DATABASE AdventureWorksDW
TO DISK = N'<a path readable by both the SQL Server service account and you>'
WITH FORMAT, INIT, COMPRESSION;
```

Then copy the resulting file to `mssql/backup/AdventureWorksDW.bak`. If you
have no such instance, download Microsoft's official sample backup instead
and place it at the same path — `mssql/init.sh` expects the logical file
names `AdventureWorksDW2014_Data` / `AdventureWorksDW2014_Log`; adjust if a
different sample version uses different names (check via `RESTORE
FILELISTONLY FROM DISK = ...`).

## Running it

```bash
cp .env.example .env
# generate real secrets: SUPERSET_SECRET_KEY, GUEST_TOKEN_JWT_SECRET,
# CUBEJS_API_SECRET, CUBE_SQL_SHARED_PASSWORD, CUBEJS_DB_PASS
# (openssl rand -hex 24), MSSQL_SA_PASSWORD (openssl rand -base64 24 --
# needs upper/lower/digit/symbol or the container refuses to start), and
# set ADMIN_PASSWORD to something other than the default.

docker compose up -d
node scripts/bootstrap.mjs
```

That's the whole setup. `bootstrap.mjs` provisions Superset (role, database
connection, dataset, native RLS backstop, dashboard, two charts, embedding)
and then **proves it worked**: a Cube-side smoke test (bypassing Superset,
exercising `checkSqlAuth` and the `reseller_sales` cube's `access_policy`
directly) and a full-stack smoke
test (real guest token → real Superset chart-data call → real Cube query →
real SQL Server), both checked against every persona's verified total. If
either prints `FAIL`, something regressed — check `docker compose logs
<service>` for whichever hop failed.

Then open **http://localhost:3000**, pick a persona, and compare the
dashboard's total against the table at the top of this README.

## Why no Dockerfiles

Every service runs from an official image, configured through documented
extension points — with one deliberate, disclosed exception:

- **Superset** — configured via `SUPERSET_CONFIG_PATH` pointing at a single
  bind-mounted file (`superset/superset_config_docker.py`). That file is
  **fully self-contained**, including the Postgres/Redis metadata wiring a
  normal Superset dev image would provide via
  `docker/pythonpath_dev/superset_config.py` — the plain published
  `apache/superset:6.1.0` tag does **not** ship that file at all (confirmed
  by exec'ing into the running container and finding nothing at that path).
  The `superset` and `superset-init` services also run as `user: root`,
  which is the one exception to "no Dockerfiles": the published image runs
  as a non-root `superset` user by default, under which its own
  `docker-bootstrap.sh` explicitly **skips** installing a Postgres driver
  (gated on `whoami = root`). Running as root lets the image's own existing
  logic install `psycopg2-binary` on startup, rather than this project
  reinventing that step or writing a custom image. Fine for a local demo;
  a real deployment should build an image with the driver baked in.
- **Cube** — `cube/` mounted at `/cube/conf`; `cube.js` and `model/` are
  Cube's own documented locations.
- **SQL Server** — the official `mcr.microsoft.com/mssql/server` image;
  `mssql-init` (same image, different command) restores the database and
  creates the `cube_reader` login once, then exits.
- **backend/frontend** — the official `node:22-alpine` image plus
  `npm install` on container start, with `node_modules` in a named volume
  (not the bind mount) so it doesn't collide with the host filesystem or
  crawl on Windows.

## Version pins and traps avoided

`apache/superset:6.1.0` · `cubejs/cube:v1.7.31` · `postgres:17` · `redis:7`
· `mcr.microsoft.com/mssql/server:2022-latest` · `node:22`

Every one of these was hit and fixed while actually running this stack, not
predicted in advance:

- **The published Superset image has no `docker/pythonpath_dev/` dev
  convenience files at all.** The commonly-documented "drop your overrides
  into `superset_config_docker.py` and the base file imports it"
  convention only applies to an image *built* from Superset's own
  `docker-compose-*.yml` flow. Use `SUPERSET_CONFIG_PATH` instead, and
  write a fully self-contained config (see `superset_config_docker.py`'s
  header comment).
- **That image runs as a non-root user, so no Postgres driver is
  installed** — `docker-bootstrap.sh`'s own driver-install step is gated on
  `whoami = root`. Metadata-DB migrations silently fall back to SQLite with
  no error if you don't catch this (confirmed: `alembic` logged `Context
  impl SQLiteImpl` the first time through). Running the service as root
  triggers the image's own existing install logic.
- **`GUEST_TOKEN_JWT_AUDIENCE`'s auto-detected default can resolve to a
  bogus host.** In this Gunicorn setup it came back as
  `http://0.0.0.0:8080/` — neither the internal URL the backend mints
  tokens from nor the public URL the browser presents them to. A mismatched
  `aud` fails verification silently from the browser's perspective (the
  embed just doesn't work). Pin it explicitly to the public URL.
- **A chart created via `POST /api/v1/chart/` with only `params` set won't
  render** — `GET /api/v1/chart/{id}/data/` refuses with *"Chart has no
  query context saved. Please save the chart again."* `query_context` (a
  separate JSON-encoded-string field, describing the same query in
  Superset's `QueryObject` shape) must be set explicitly; `bootstrap.mjs`'s
  `ensureChart` does this.
- **Cube's YAML `description:` fields are run through a Jinja/Python
  preprocessing pass** — and, as later discovered, so is the rest of the
  file, comments included (see the `access_policy` entry below). A literal
  `{ member: "...", ... }` JSON snippet quoted in prose crashed the schema
  compiler with *"Failed to parse Python expression."* Keep code-like
  snippets in YAML `#` comments instead of `description:` text — but keep
  literal double-curly braces out of comments too.
- Superset's SSRF guard (`PREVENT_UNSAFE_DB_CONNECTIONS`, on by default)
  blocks connections to private/RFC1918 ranges — exactly what the Docker
  bridge network's `cube` service resolves to. Disabled deliberately for
  this fully-private compose network.
- Cube's mssql driver forces `encrypt: false` and exposes no
  `trustServerCertificate` env var — the generic `CUBEJS_DB_SSL_CA/CERT/KEY`
  variables exist but are silently ignored by this specific driver.
- `CUBEJS_PG_SQL_PORT` has no default — omitting it silently disables the
  SQL API entirely, rather than falling back to a conventional port.
- Cube Store is not required for the SQL API itself; dev mode auto-starts an
  embedded one. This project ran a single Cube container on that basis
  until RLS moved to a declarative `access_policy` — which turned out to
  need `CUBEJS_DEV_MODE=false` to be enforced at all (see "Two hard
  constraints" above), and production mode has no embedded Cube Store. A
  dedicated `cubestore` service exists in `docker-compose.yml` for exactly
  that reason, not for pre-aggregations (this project still defines none).
- **`access_policy`'s docs mostly show Cube Cloud's `userAttributes` and a
  `group`/role model** built via `contextToRoles` — removed in Cube 1.7.0.
  Cube Core has no equivalent role-derivation step; use `securityContext`
  directly in filter values and `if` conditions instead, and `group: "*"`
  (the documented "any group" shorthand) when there's no real role
  hierarchy to model. See "Why the filter is declarative" above.
- **`access_policy`'s expression syntax rejects `==`/`!=` comparisons
  outright** — confirmed live: `if: "{ securityContext.x != 'y' }"` fails
  schema compilation with *"Failed to parse Python expression... Comp_opContext:
  !="*. Only boolean logic (`not`/`or`) and bare attribute truthiness are
  supported; compute any comparison in `cube.js` and hand over an
  already-boolean field instead (see `cube.js`'s `isUnrestricted`).
- **Cube runs entire YAML data-model files — comments included — through
  its Jinja preprocessor** before parsing them as YAML, not just
  `description:` fields as first assumed (see the entry above about
  `description:` and curly braces). A code comment that happened to spell
  out literal double-curly-brace syntax crashed the schema compiler with
  *"unexpected end of variable block"*, pointing at the comment line, not
  at any functional code.

## Discovered during verification

**`mssql-init` can fail outright after an unclean shutdown** (host sleep,
Docker Desktop killed rather than stopped — exit code 137 on the `mssql`
container). Its healthcheck only confirms the SQL Server *engine* is
accepting connections (`SELECT 1` against master); after an unclean
shutdown, SQL Server runs crash recovery per user database independently,
and `AdventureWorksDW` can still be finishing that for a few seconds after
the server itself is reachable. Confirmed live: the existence check
(`DB_ID('AdventureWorksDW')`, which only reads the master catalog)
succeeded while a subsequent `-d AdventureWorksDW` connection failed with
*"Login failed"* — misleading text for what is actually "this database
isn't ready yet." Fixed with a short retry loop (`wait_for_database_online`
in `mssql/init.sh`) before any command that needs the database open,
rather than trusting the healthcheck's definition of "ready" to cover it.

`bootstrap.mjs` checks, at runtime, whether Superset's built-in `Gamma`
role (which `Embedded` clones its permissions from) includes anything
SQL-Lab-related, rather than assuming it doesn't. On this Superset install
it found: **`can_export_streaming_csv` on `SQLLab`** is part of Gamma's
default permission set. On its own this permission cannot open SQL Lab's
query interface (that needs `menu_access on SQL Lab` and `can_sql_json`,
neither of which `Embedded` has), so it appears inert here — but it means
"no SQL Lab access" for the `Embedded` role is a checked, not assumed,
property, and the check itself found something worth knowing about rather
than a clean bill of health.

**The backend's cached Superset login expires on a long-running process.**
Every automated check in this project re-creates the backend container
right before testing it, which resets its in-memory login cache — so this
bug only ever showed up when a real person left the stack running and came
back later: the browser's guest-token request failed with *"Failed to mint
guest token"*, and the backend logs showed the real cause,
`GET /api/v1/security/csrf_token/ -> 401: {"msg": "Token has expired"}`.
`backend/server.js` cached its Superset admin login (`ensureSupersetLogin`)
exactly once at process start and never refreshed it — fine for a
short-lived script like `bootstrap.mjs`, wrong for a service meant to run
for the lifetime of the demo. Fixed with `mintGuestTokenWithRetry`: on a
401, discard the cached login, log in again once, and retry. This is
exactly why the frontend's persona switcher matters as a manual check
too — no scripted test here was structured to keep a process running long
enough to hit this on its own.

**The table chart failed with "Guest user cannot modify chart payload"** —
also only visible from a real embedded render, not from any direct API
check, because it's specific to how the dashboard's own React code
re-issues a chart's query rather than the simpler "just replay what's
stored" path used everywhere else in this project's testing. Superset's
anti-tamper guard (`query_context_modified()` in
`superset/security/manager.py`) compares a guest's rendered request against
the chart's saved `params`/`query_context` via exact
`json.dumps(..., sort_keys=True)` equality on the `metrics`/`columns`/
`groupby`/`orderby` fields.

This one took two wrong guesses before getting real evidence. First
suspected an inline ad-hoc metric object (`{expressionType, column,
aggregate, label}`) picking up extra fields from the dashboard's own
normalization — fixed by giving the dataset a named metric
(`total_sales_amount_sum`) and referencing it by **string** instead
(`ensureDatasetMetric` in `scripts/bootstrap.mjs`; a string can't drift
from itself, so this is a real robustness improvement regardless). It
didn't fix the actual error. Rather than guess a third time, the real fix
came from temporarily patching `query_context_modified()` inside the
running container to print exactly what mismatched, then reproducing the
error live: `REJECT[orderby] queries-level requested={'["total_sales_amount_sum",
false]'} stored=set()`. **Table charts auto-generate a default sort (by
their first metric, descending) at render time**, regardless of whether a
"Sort by" control was ever configured — and the chart's saved
`query_context` had no `orderby` at all, so no real render could ever
match it. Fixed by setting `orderby: [[metric_name, false]]` explicitly in
both `params` and `query_context` to match what the viz plugin generates.
(The big-number chart never hit any of this: its field is singular
`metric`, not one of the four keys this guard checks, and it has no sort
concept in the first place.)

## Fail-open hazards this design actively defends against

Each of these would otherwise silently return unfiltered data with **no
error** — verified by deliberately triggering the closest analog on a live
instance where practical (see "Layer 2" above for the `__user` switch-denial
proof, and `check_sql_auth`'s rejection of an unrecognized username, both
confirmed live):

1. **Empty or missing `user.username` disables all guest RLS** in Superset
   4.1.3–6.1.0 (`is_guest_user()` gates on a truthy username). The backend's
   guest-token minting refuses to proceed without one.
2. **A typo in an RLS rule key escalates its scope** — 6.1.0's guest-token
   `rls` schema is permissive, so `{"datasource": ...}` instead of
   `{"dataset": ...}` silently becomes a global rule, HTTP 200. Payloads are
   built only through the typed helper in `backend/server.js`.
3. **A row-filter that only filters when a security context is present
   fails open when it's absent.** `cube/cube.js`'s `checkSqlAuth` rejects
   any connection without a recognized identity outright, so
   `reseller_sales.yml`'s `access_policy` never runs without one — and even
   in a hypothetical where it did, its condition
   (`not securityContext.isUnrestricted`) would still hold true for a
   missing/undefined value, producing `rls_territory_group = ''` (zero
   rows), never the unfiltered set. Fails closed either way, not open.
4. **Pre-aggregations built by Cube's refresh worker run with an undefined
   security context**, so a row-filtering hook — whether an imperative
   `query_rewrite` or a declarative `access_policy` — would not apply to a
   scheduled build; it would build unfiltered. This project defines **no
   pre-aggregations**, specifically to avoid that failure mode.
5. **`X-Frame-Options: SAMEORIGIN` is emitted by default** and blocks the
   iframe regardless of `frame-ancestors` — fixed via
   `TALISMAN_CONFIG["frame_options"] = None`. The older `HTTP_HEADERS`
   workaround makes this worse (appends a conflicting header instead of
   replacing it). **This alone was not enough**: Superset's own
   `initialization/__init__.py` picks `TALISMAN_DEV_CONFIG` instead of
   `TALISMAN_CONFIG` whenever `app.debug` is set (true here —
   `FLASK_DEBUG=true`), and `TALISMAN_DEV_CONFIG` is a separate variable
   with its own defaults. Setting only `TALISMAN_CONFIG` left the live
   response still carrying `X-Frame-Options: SAMEORIGIN` with no
   `frame-ancestors`, confirmed by curling the actual `/embedded/<uuid>`
   route directly — the fix is to assign the same config dict to both
   variable names.
6. **Guest identity does not survive into Celery.** No worker/beat services
   run in this stack.
7. **An unrecognized connection identity is rejected outright**, not passed
   through with a default/unrestricted scope — verified live: connecting as
   the database's own placeholder username fails with *"password
   authentication failed"* rather than returning data.

## Project layout

```
docker-compose.yml       -- orchestrates every service (incl. cubestore --
                             required by reseller_sales.yml's access_policy)
.env.example              -- copy to .env; see inline comments per variable
personas.json              -- single source of truth for the 4 demo personas
mssql/
  init.sh                   -- one-shot restore + cube_reader login (idempotent)
  backup/AdventureWorksDW.bak -- gitignored; see "Data source" above
scripts/
  bootstrap.mjs               -- idempotent Superset provisioning + self-verification
cube/
  cube.js                    -- identity layer: checkSqlAuth + canSwitchSqlUser
  model/cubes/                -- reseller_sales, sales_territory, product, calendar
  model/cubes/reseller_sales.yml -- the row filter itself, as a declarative
                                 access_policy (Cube's recommended RLS mechanism)
  model/views/reseller_sales_view.yml -- what Superset's dataset is built on
superset/
  superset_config_docker.py  -- self-contained config: metadata DB wiring,
                                 embedding, CORS, Talisman, DB_CONNECTION_MUTATOR
backend/
  server.js                  -- /api/personas, /api/guest-token, /api/explain
  supersetClient.js           -- login -> CSRF -> guest token (shared with bootstrap.mjs)
  personas.js                  -- server-side authority; browser only ever sends an id
frontend/
  main.js                     -- persona switcher + embedded dashboard + query-log panel
```

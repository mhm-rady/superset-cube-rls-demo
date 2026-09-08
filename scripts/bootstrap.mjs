#!/usr/bin/env node
// Idempotent Superset provisioning for the RLS demo, entirely via Superset's
// REST API -- no clicking in the UI. Safe to re-run: every step checks
// current state before creating anything, and role/permission assignment is
// always recomputed from scratch rather than incrementally patched (see
// setRolePermissionIds below for why that matters).
//
// Run from the repo root, on the HOST (not inside a container), after
// `docker compose up -d`:
//   node scripts/bootstrap.mjs
//
// Zero npm dependencies -- reuses backend/supersetClient.js directly (which
// is itself dependency-free, built only on Node's global fetch) so this
// script needs no node_modules of its own.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupersetClient } from '../backend/supersetClient.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const envPath = path.join(repoRoot, '.env');

function readEnvFile(p) {
  const map = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    map[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return map;
}

function setEnvValue(p, key, value) {
  const lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n') : [];
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  writeFileSync(p, next.join('\n'), 'utf8');
}

if (!existsSync(envPath)) {
  throw new Error('.env not found -- copy .env.example to .env (and run scripts/00-configure-sqlserver.ps1) first.');
}
const env = readEnvFile(envPath);

// This script runs on the host, so it talks to Superset's published port --
// not the `http://superset:8088` compose-network address backend/server.js
// uses.
const SUPERSET_URL = 'http://localhost:8088';
const FRONTEND_ORIGIN = env.FRONTEND_ORIGIN || 'http://localhost:3000';

const DATABASE_NAME = 'Cube RLS Demo';
const DATASET_SCHEMA = 'public';
const DATASET_TABLE = 'reseller_sales_view';
const EMBEDDED_ROLE_NAME = 'Embedded';
const DASHBOARD_TITLE = 'Reseller Sales (RLS Demo)';
const RLS_RULE_NAME = 'Embedded guest -- reassert __user';

// The username baked into Superset's STORED Database connection string.
// Every real request's connection has its username rewritten away from
// this by DB_CONNECTION_MUTATOR (superset/superset_config_docker.py)
// before it reaches Cube. Deliberately not a recognized persona --
// cube/cube.js's checkSqlAuth rejects it outright, so if the mutator ever
// fails to fire, the connection is refused rather than silently
// unfiltered. Fail closed, not open.
const UNSCOPED_SENTINEL_USER = 'unscoped_sentinel';

const superset = createSupersetClient(SUPERSET_URL);

async function waitForSuperset() {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await superset.login('admin', env.ADMIN_PASSWORD);
      console.log('Logged in to Superset as admin.');
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`Superset never became ready to log in to: ${err.message}`);
      }
      console.log('Superset not ready yet, retrying...');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/**
 * Every "find existing X" lookup below uses this instead of a Rison
 * server-side filter. Superset's FAB-generated list APIs vary in whether
 * they declare `search_columns` for a given field (confirmed absent on
 * security/permissions-resources, for example) -- paginating and matching
 * client-side is slower but correct regardless of that per-endpoint,
 * per-version detail.
 */
async function findByField(resourcePath, field, value) {
  const pageSize = 100;
  for (let page = 0; ; page++) {
    const q = encodeURIComponent(`(page_size:${pageSize},page:${page})`);
    const data = await superset.request('GET', `/api/v1/${resourcePath}/?q=${q}`);
    const match = data.result.find((row) => row[field] === value);
    if (match) return match;
    if (data.result.length < pageSize) return null;
  }
}

async function findPermissionViewMenuId(permissionName, viewMenuName) {
  const pageSize = 100;
  for (let page = 0; ; page++) {
    const q = encodeURIComponent(`(page_size:${pageSize},page:${page})`);
    const data = await superset.request('GET', `/api/v1/security/permissions-resources/?q=${q}`);
    const match = data.result.find(
      (row) => row.permission.name === permissionName && row.view_menu.name === viewMenuName
    );
    if (match) return match.id;
    if (data.result.length < pageSize) return null;
  }
}

async function ensureRole(name) {
  const existing = await findByField('security/roles', 'name', name);
  if (existing) {
    console.log(`Role '${name}' already exists (id ${existing.id}).`);
    return existing.id;
  }
  const created = await superset.withCsrf('POST', '/api/v1/security/roles/', { name });
  console.log(`Created role '${name}' (id ${created.id}).`);
  return created.id;
}

async function getRolePermissions(roleId) {
  const data = await superset.request('GET', `/api/v1/security/roles/${roleId}/permissions/`);
  return data.result; // [{ id, permission_name, view_menu_name }]
}

async function setRolePermissionIds(roleId, permissionViewMenuIds) {
  // POST here REPLACES the role's entire permission set (`role.permissions
  // = permissions` server-side) -- it is not additive. Always compute and
  // pass the FULL desired set, which is what makes this idempotent: every
  // run recomputes from Gamma + all_datasource_access rather than trying
  // to patch whatever the role currently has.
  await superset.withCsrf('POST', `/api/v1/security/roles/${roleId}/permissions`, {
    permission_view_menu_ids: permissionViewMenuIds,
  });
}

async function ensureEmbeddedRolePermissions(embeddedRoleId) {
  const gamma = await findByField('security/roles', 'name', 'Gamma');
  if (!gamma) throw new Error("Built-in 'Gamma' role not found -- has `superset init` completed?");
  const gammaPermissions = await getRolePermissions(gamma.id);

  // Gamma is Superset's own least-privileged built-in viewer role and,
  // unlike Admin/Alpha, does not include SQL Lab access by default -- that
  // is exactly the property this role needs (see README "The honest
  // boundary"). Verify it at runtime rather than trust it silently: a
  // future Superset version changing Gamma's defaults should be a loud
  // warning here, not a silently inherited regression.
  const sqlLabLeak = gammaPermissions.filter(
    (p) => /sql_?lab|can_sql_json/i.test(p.permission_name) || /sql\s*lab/i.test(p.view_menu_name)
  );
  if (sqlLabLeak.length > 0) {
    console.warn(
      `WARNING: the built-in 'Gamma' role on this Superset install appears to include SQL Lab-related access:`
    );
    for (const p of sqlLabLeak) console.warn(`  - ${p.permission_name} on ${p.view_menu_name}`);
    console.warn(
      "The 'Embedded' role will inherit this. Do not treat \"no SQL Lab access\" as guaranteed until you've checked this."
    );
  }

  // Single-dataset demo: all_datasource_access is not a meaningful
  // over-grant here, because there is only one dataset for it to grant
  // access to. In a multi-dataset deployment, replace this with the
  // narrower per-dataset "datasource_access" permission instead (view_menu
  // name "[<database_name>].[<dataset_name>](id:<dataset id>)" -- see
  // superset/security/manager.py's get_dataset_perm -- looked up the same
  // way via findPermissionViewMenuId).
  const allDatasourceAccessId = await findPermissionViewMenuId('all_datasource_access', 'all_datasource_access');
  if (!allDatasourceAccessId) {
    throw new Error("Could not find the built-in 'all_datasource_access' permission -- has `superset init` completed?");
  }

  const desired = new Set([...gammaPermissions.map((p) => p.id), allDatasourceAccessId]);
  await setRolePermissionIds(embeddedRoleId, [...desired]);
  console.log(`Set ${desired.size} permissions on '${EMBEDDED_ROLE_NAME}' (cloned from Gamma + all_datasource_access).`);
}

async function ensureDatabase() {
  const existing = await findByField('database', 'database_name', DATABASE_NAME);
  if (existing) {
    console.log(`Database '${DATABASE_NAME}' already exists (id ${existing.id}).`);
    return existing.id;
  }

  const sqlalchemyUri = `postgresql+psycopg2://${UNSCOPED_SENTINEL_USER}:${env.CUBE_SQL_SHARED_PASSWORD}@cube:${env.CUBEJS_PG_SQL_PORT}/cube`;

  await superset
    .withCsrf('POST', '/api/v1/database/test_connection/', {
      sqlalchemy_uri: sqlalchemyUri,
      database_name: DATABASE_NAME,
    })
    .catch((err) => {
      throw new Error(
        `Cube connection test failed -- is the cube container healthy, and is CUBEJS_PG_SQL_PORT/CUBE_SQL_SHARED_PASSWORD correct in .env? ${err.message}`
      );
    });
  console.log('Cube connection test succeeded.');

  const created = await superset.withCsrf('POST', '/api/v1/database/', {
    database_name: DATABASE_NAME,
    sqlalchemy_uri: sqlalchemyUri,
    expose_in_sqllab: false,
    allow_ctas: false,
    allow_cvas: false,
    allow_dml: false,
    // Identity propagation uses DB_CONNECTION_MUTATOR (Layer 1 -- see
    // superset/superset_config_docker.py), a stronger, independent
    // mechanism. Superset's own built-in impersonation flag stays off so
    // there is exactly one mechanism doing this job, not two overlapping
    // ones.
    impersonate_user: false,
  });
  console.log(`Created database '${DATABASE_NAME}' (id ${created.id}).`);
  return created.id;
}

async function ensureDataset(databaseId) {
  const existing = await findByField('dataset', 'table_name', DATASET_TABLE);
  if (existing) {
    console.log(`Dataset '${DATASET_TABLE}' already exists (id ${existing.id}).`);
    return existing.id;
  }
  const created = await superset.withCsrf('POST', '/api/v1/dataset/', {
    database: databaseId,
    schema: DATASET_SCHEMA,
    table_name: DATASET_TABLE,
    // No `sql` field -- that is what makes this a PHYSICAL dataset.
    // Virtual (SQL) datasets wrap their query in a subquery, and Superset
    // applies RLS to the OUTER query, outside anything Cube ever parses --
    // see cube/model/views/reseller_sales_view.yml.
  });
  console.log(`Created dataset '${DATASET_TABLE}' (id ${created.id}).`);
  return created.id;
}

const TOTAL_SALES_METRIC_NAME = 'total_sales_amount_sum';

/**
 * A named dataset metric, referenced by charts as a plain string rather
 * than an inline ad-hoc metric object. This is not a style preference --
 * Superset's guest-token anti-tamper guard (query_context_modified() in
 * superset/security/manager.py) rejects a chart's "metrics" array with
 * "Guest user cannot modify chart payload" whenever the browser's rendered
 * request and the chart's saved params don't produce byte-identical
 * `json.dumps(..., sort_keys=True)` output. An inline ad-hoc metric object
 * is exactly the kind of value the frontend's own normalization can
 * silently enrich with extra fields (verified live: a chart using an
 * inline metrics array failed this guest check even though the exact same
 * data fetched fine through the plain, non-guest-token GET endpoint,
 * which replays the stored query as-is and has nothing to compare). A
 * plain string can't pick up extra fields, so it can't drift from itself.
 */
async function ensureDatasetMetric(datasetId) {
  const dataset = await superset.request('GET', `/api/v1/dataset/${datasetId}`);
  const existingMetrics = dataset.result.metrics || [];
  if (existingMetrics.some((m) => m.metric_name === TOTAL_SALES_METRIC_NAME)) {
    console.log(`Dataset metric '${TOTAL_SALES_METRIC_NAME}' already exists.`);
    return;
  }
  // PUT replaces the whole metrics array -- existing metrics (e.g. the
  // auto-generated "count") must be included WITH their id, or Superset
  // treats them as new and rejects the request as a duplicate.
  await superset.withCsrf('PUT', `/api/v1/dataset/${datasetId}`, {
    metrics: [
      ...existingMetrics.map((m) => ({ id: m.id, metric_name: m.metric_name, expression: m.expression, metric_type: m.metric_type })),
      {
        metric_name: TOTAL_SALES_METRIC_NAME,
        expression: 'SUM(total_sales_amount)',
        metric_type: 'sum',
        verbose_name: 'Total Reseller Sales',
      },
    ],
  });
  console.log(`Added dataset metric '${TOTAL_SALES_METRIC_NAME}'.`);
}

async function ensureRlsRule(datasetId, roleId) {
  const existing = await findByField('rowlevelsecurity', 'name', RLS_RULE_NAME);
  if (existing) {
    console.log(`RLS rule '${RLS_RULE_NAME}' already exists (id ${existing.id}).`);
    return existing.id;
  }
  const created = await superset.withCsrf('POST', '/api/v1/rowlevelsecurity/', {
    name: RLS_RULE_NAME,
    description:
      "Layer 2 backstop (see cube/cube.js): reasserts the current Superset username as Cube's __user on every " +
      'query. Redundant with Layer 1 (DB_CONNECTION_MUTATOR) when everything works; converts a connection-identity ' +
      'mismatch into a hard query error instead of a silent leak when it does not.',
    filter_type: 'Regular',
    tables: [datasetId],
    roles: [roleId],
    clause: "__user = '{{ current_username() }}'",
  });
  console.log(`Created RLS rule '${RLS_RULE_NAME}' (id ${created.id}).`);
  return created.id;
}

async function ensureDashboard() {
  const existing = await findByField('dashboard', 'dashboard_title', DASHBOARD_TITLE);
  if (existing) {
    console.log(`Dashboard '${DASHBOARD_TITLE}' already exists (id ${existing.id}).`);
    return existing.id;
  }
  const created = await superset.withCsrf('POST', '/api/v1/dashboard/', {
    dashboard_title: DASHBOARD_TITLE,
    published: true,
  });
  console.log(`Created dashboard '${DASHBOARD_TITLE}' (id ${created.id}).`);
  return created.id;
}

async function ensureChart({ name, datasetId, dashboardId, vizType, params, queryColumns = [], queryMetrics, rowLimit = 100, orderby }) {
  const existing = await findByField('chart', 'slice_name', name);
  if (existing) {
    console.log(`Chart '${name}' already exists (id ${existing.id}).`);
    return existing.id;
  }
  const formData = { viz_type: vizType, datasource: `${datasetId}__table`, ...params, ...(orderby ? { orderby } : {}) };
  // Verified live against a running instance: the dashboard's own chart-data
  // endpoint (/api/v1/chart/{id}/data/) refuses to run with no `query_context`
  // saved on the chart ("Chart has no query context saved"), even though
  // `params` alone is enough for `POST /api/v1/chart/`'s schema to accept the
  // chart. Both fields are written here so the chart renders on first load
  // rather than needing a manual re-save through the Explore UI afterward.
  //
  // `orderby` specifically: table charts auto-generate a default sort (by
  // their first metric, descending) at render time REGARDLESS of whether a
  // "Sort by" control was ever configured. Confirmed by adding temporary
  // debug logging to Superset's own query_context_modified() and watching a
  // real embedded-dashboard request fail guest verification with
  // `REJECT[orderby] queries-level requested={'["total_sales_amount_sum",
  // false]'} stored=set()` -- the saved chart had no orderby at all, so any
  // real render's auto-generated sort could never match. Must be set to
  // EXACTLY what the viz plugin would auto-generate, not left absent.
  const queryContext = {
    datasource: { id: datasetId, type: 'table' },
    force: false,
    queries: [
      {
        filters: [],
        extras: { having: '', where: '' },
        applied_time_extras: {},
        columns: queryColumns,
        metrics: queryMetrics,
        annotation_layers: [],
        row_limit: rowLimit,
        series_columns: [],
        order_desc: true,
        ...(orderby ? { orderby } : {}),
        url_params: {},
        custom_params: {},
        custom_form_data: {},
      },
    ],
    form_data: formData,
    result_format: 'json',
    result_type: 'full',
  };
  const created = await superset.withCsrf('POST', '/api/v1/chart/', {
    slice_name: name,
    datasource_id: datasetId,
    datasource_type: 'table',
    viz_type: vizType,
    // Both of the chart POST schema's `params` and `query_context` fields
    // are JSON-encoded STRINGS, not nested objects -- easy to get backwards.
    params: JSON.stringify(formData),
    query_context: JSON.stringify(queryContext),
    dashboards: [dashboardId],
  });
  console.log(`Created chart '${name}' (id ${created.id}).`);
  return created.id;
}

async function ensureEmbedding(dashboardId) {
  try {
    const existing = await superset.request('GET', `/api/v1/dashboard/${dashboardId}/embedded`);
    if (existing && existing.result) {
      console.log(`Embedding already enabled (uuid ${existing.result.uuid}).`);
      return existing.result.uuid;
    }
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const data = await superset.withCsrf('POST', `/api/v1/dashboard/${dashboardId}/embedded`, {
    allowed_domains: [FRONTEND_ORIGIN],
  });
  console.log(`Enabled embedding (uuid ${data.result.uuid}).`);
  return data.result.uuid;
}

/**
 * Connects to Cube's SQL API directly, as each persona, and compares the
 * result against personas.json's verified expectedTotal. This exercises
 * cube.js's checkSqlAuth plus the reseller_sales cube's declarative
 * access_policy in isolation -- the Cube side of Layer 1 -- which is a
 * necessary (not sufficient) condition for the full stack working. It does
 * NOT exercise DB_CONNECTION_MUTATOR or Superset's
 * RLS rule, since it bypasses Superset entirely by design (bootstrap.mjs
 * has no 'pg' dependency of its own). The full path -- switch personas in
 * the browser and compare the dashboard's total -- is the headline test
 * described in the README and cannot be automated from here.
 *
 * Runs inside the `backend` container via `docker compose exec`, reusing
 * the 'pg' package already installed there instead of adding a dependency
 * to this script.
 */
async function smokeTestCubeTotals(personas) {
  console.log('\n=== Cube-side smoke test (bypasses Superset; see comment above) ===');
  let allPassed = true;
  for (const persona of personas) {
    const script = `
      const { Client } = require('pg');
      (async () => {
        const c = new Client({
          host: 'cube',
          port: ${Number(env.CUBEJS_PG_SQL_PORT)},
          user: ${JSON.stringify(persona.id)},
          password: process.env.CUBE_SQL_SHARED_PASSWORD,
          database: 'cube',
        });
        await c.connect();
        const r = await c.query('SELECT MEASURE(total_sales_amount) AS total FROM reseller_sales_view');
        console.log(JSON.stringify(r.rows[0]));
        await c.end();
      })().catch((err) => { console.error(String(err)); process.exit(1); });
    `;
    try {
      const { stdout } = await execFileAsync('docker', ['compose', 'exec', '-T', 'backend', 'node', '-e', script], {
        cwd: repoRoot,
      });
      const total = Number(JSON.parse(stdout.trim()).total);
      const expected = persona.expectedTotal;
      const ok = Math.abs(total - expected) < 0.01;
      allPassed = allPassed && ok;
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${persona.id.padEnd(6)} got ${total.toFixed(2)}, expected ${expected.toFixed(2)}`
      );
    } catch (err) {
      allPassed = false;
      console.log(`  FAIL  ${persona.id.padEnd(6)} query failed: ${err.message}`);
    }
  }
  if (!allPassed) {
    console.warn('One or more personas did not match their expected total -- see cube/cube.js and check `docker compose logs cube`.');
  }
  return allPassed;
}

/**
 * The real, complete path: backend guest-token endpoint -> Superset's
 * guest-token-authenticated chart-data API -> Superset's own dataset/RLS
 * layer -> Cube -> SQL Server. This is what a browser actually exercises
 * (minus the iframe/JS rendering itself, which this script cannot check).
 *
 * Force-recreates the backend container first: `env_file` values are read
 * at container CREATION, not on every start, so a plain `docker compose
 * restart backend` would still see the old (blank) SUPERSET_EMBED_DASHBOARD_UUID
 * from before this run wrote a real one to .env.
 */
async function smokeTestFullStack(personas, bigNumberChartId) {
  console.log('\n=== Full-stack smoke test (backend -> Superset -> Cube -> SQL Server) ===');
  console.log('Recreating the backend container so it picks up the embed UUID just written to .env...');
  await execFileAsync('docker', ['compose', 'up', '-d', '--force-recreate', 'backend'], { cwd: repoRoot });

  const backendUrl = `http://localhost:${env.BACKEND_PORT}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${backendUrl}/healthz`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('backend did not become healthy after recreation');
    await new Promise((r) => setTimeout(r, 1000));
  }

  let allPassed = true;
  for (const persona of personas) {
    try {
      const tokenRes = await fetch(`${backendUrl}/api/guest-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId: persona.id }),
      });
      if (!tokenRes.ok) throw new Error(`guest-token endpoint -> ${tokenRes.status}`);
      const { token } = await tokenRes.json();

      const dataRes = await fetch(`${SUPERSET_URL}/api/v1/chart/${bigNumberChartId}/data/`, {
        headers: { 'X-GuestToken': token },
      });
      if (!dataRes.ok) throw new Error(`chart data endpoint -> ${dataRes.status}`);
      const body = await dataRes.json();
      const total = Number(Object.values(body.result[0].data[0])[0]);
      const ok = Math.abs(total - persona.expectedTotal) < 0.01;
      allPassed = allPassed && ok;
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${persona.id.padEnd(6)} got ${total.toFixed(2)}, expected ${persona.expectedTotal.toFixed(2)}`
      );
    } catch (err) {
      allPassed = false;
      console.log(`  FAIL  ${persona.id.padEnd(6)} ${err.message}`);
    }
  }
  if (!allPassed) {
    console.warn('One or more personas failed the full-stack test -- see docker compose logs backend / superset.');
  }
  return allPassed;
}

async function main() {
  await waitForSuperset();

  const embeddedRoleId = await ensureRole(EMBEDDED_ROLE_NAME);
  await ensureEmbeddedRolePermissions(embeddedRoleId);

  const databaseId = await ensureDatabase();
  const datasetId = await ensureDataset(databaseId);
  await ensureDatasetMetric(datasetId);
  await ensureRlsRule(datasetId, embeddedRoleId);

  const dashboardId = await ensureDashboard();
  const bigNumberChartId = await ensureChart({
    name: 'Total Reseller Sales',
    datasetId,
    dashboardId,
    vizType: 'big_number_total',
    params: { metric: TOTAL_SALES_METRIC_NAME },
    queryColumns: [],
    queryMetrics: [TOTAL_SALES_METRIC_NAME],
    rowLimit: 1,
  });
  await ensureChart({
    name: 'Reseller Sales by Territory',
    datasetId,
    dashboardId,
    vizType: 'table',
    params: {
      query_mode: 'aggregate',
      groupby: ['territory_group', 'territory_region'],
      metrics: [TOTAL_SALES_METRIC_NAME],
      row_limit: 100,
    },
    queryColumns: ['territory_group', 'territory_region'],
    queryMetrics: [TOTAL_SALES_METRIC_NAME],
    rowLimit: 100,
    // Must match the table viz's own auto-generated default sort exactly --
    // see the long comment in ensureChart for why this is required at all.
    orderby: [[TOTAL_SALES_METRIC_NAME, false]],
  });
  console.log(
    "Note: the plan called for a third (trend-line) chart. Its viz_type's exact params shape was not verified " +
      'with confidence ahead of time (unlike the role/permission/RLS wiring above, a wrong params blob here is a ' +
      'cosmetic rendering bug, not a silent security failure) -- add it via the Superset UI if wanted; the two ' +
      'charts above are sufficient to verify RLS.'
  );

  const embedUuid = await ensureEmbedding(dashboardId);
  setEnvValue(envPath, 'SUPERSET_EMBED_DASHBOARD_UUID', embedUuid);
  console.log(`\nWrote SUPERSET_EMBED_DASHBOARD_UUID=${embedUuid} to .env`);

  const personasPath = path.join(repoRoot, 'personas.json');
  const personas = JSON.parse(readFileSync(personasPath, 'utf8')).personas;
  await smokeTestCubeTotals(personas);
  await smokeTestFullStack(personas, bigNumberChartId);

  console.log('\nDone. Open http://localhost:3000');
}

main().catch((err) => {
  console.error('\nbootstrap failed:', err);
  process.exit(1);
});

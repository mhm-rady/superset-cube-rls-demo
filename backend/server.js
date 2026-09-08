// Token broker for the embedded Superset dashboard, plus a query-log
// inspection endpoint. This is hop 2 of the RLS handover described in the
// README: browser -> here -> Superset guest-token API -> (embedded iframe)
// -> Cube SQL API -> SQL Server.
import express from 'express';
import pg from 'pg';
import { listPersonas, getPersona } from './personas.js';
import { createSupersetClient, SupersetApiError } from './supersetClient.js';

const {
  SUPERSET_INTERNAL_URL,
  SUPERSET_EMBED_DASHBOARD_UUID,
  BACKEND_PORT,
  FRONTEND_ORIGIN,
  CUBEJS_PG_SQL_PORT,
  CUBE_SQL_SHARED_PASSWORD,
  ADMIN_PASSWORD,
} = process.env;

const app = express();

// Only the frontend origin, only the methods/headers actually used. The
// backend -- not Superset -- is what the browser calls cross-origin to get
// a guest token; Superset's own CORS config (superset_config_docker.py) is
// a separate, narrower concern.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

const superset = createSupersetClient(SUPERSET_INTERNAL_URL);

// This backend authenticates to Superset as the FAB "admin" user, which is
// -- deliberately, not coincidentally -- also the "admin" persona in
// personas.json. See cube/cube.js and superset/superset_config_docker.py:
// docker-init.sh hardcodes the FAB admin's username to "admin", and
// DB_CONNECTION_MUTATOR propagates whatever Superset username is active
// straight through to Cube, so giving the unrestricted demo persona the
// same name means Superset's own admin naturally gets unfiltered access to
// the Cube-backed dataset during setup, with no separate carve-out needed.
// Cached indefinitely, NOT re-fetched on a timer -- Superset's access token
// has its own expiry (observed: well under 24h), and this backend is meant
// to run for the lifetime of the demo, so it WILL outlive the cached token.
// mintGuestTokenWithRetry below is what actually handles that: on a 401 it
// clears this cache and logs in again once. Do not remove that retry
// thinking the login only needs to happen at startup.
let loginPromise = null;
function ensureSupersetLogin() {
  if (!loginPromise) {
    loginPromise = superset.login('admin', ADMIN_PASSWORD);
  }
  return loginPromise;
}

async function mintGuestTokenWithRetry(args) {
  await ensureSupersetLogin();
  try {
    return await superset.mintGuestToken(args);
  } catch (err) {
    if (err instanceof SupersetApiError && err.status === 401) {
      loginPromise = null; // discard the expired token
      await ensureSupersetLogin();
      return await superset.mintGuestToken(args);
    }
    throw err;
  }
}

app.get('/api/personas', (req, res) => {
  res.json(listPersonas());
});

// Lets the frontend learn the embed UUID and Superset's browser-facing URL
// without hardcoding or duplicating them -- both come from the same .env
// scripts/bootstrap.mjs writes to, so there is exactly one place they can
// drift out of sync.
app.get('/api/embed-config', (req, res) => {
  if (!SUPERSET_EMBED_DASHBOARD_UUID) {
    return res.status(500).json({
      error: 'SUPERSET_EMBED_DASHBOARD_UUID is not set -- run scripts/bootstrap.mjs first',
    });
  }
  res.json({
    dashboardUuid: SUPERSET_EMBED_DASHBOARD_UUID,
    supersetPublicUrl: process.env.SUPERSET_PUBLIC_URL,
  });
});

app.post('/api/guest-token', async (req, res) => {
  try {
    const { personaId } = req.body || {};
    const persona = getPersona(personaId);
    if (!persona) {
      return res.status(400).json({ error: `Unknown persona '${personaId}'` });
    }
    if (!SUPERSET_EMBED_DASHBOARD_UUID) {
      return res.status(500).json({
        error: 'SUPERSET_EMBED_DASHBOARD_UUID is not set -- run scripts/bootstrap.mjs first',
      });
    }

    const [firstName, ...rest] = persona.displayName.split(' ');
    const token = await mintGuestTokenWithRetry({
      // The one value that must never be empty -- see supersetClient.js's
      // mintGuestToken guard for why.
      username: persona.id,
      firstName,
      lastName: rest.join(' ') || persona.id,
      resources: [{ type: 'dashboard', id: SUPERSET_EMBED_DASHBOARD_UUID }],
      // Layer 2 (see cube/cube.js): an explicit __user assertion. Redundant
      // with Layer 1's connection-level identity when everything is
      // working correctly, and a hard-failure backstop when it isn't --
      // canSwitchSqlUser only allows this to be a no-op reassertion of the
      // same identity, never a real escalation. The admin persona
      // (territoryGroup '*') carries no rls clause: there is nothing to
      // restrict for it.
      rls: persona.territoryGroup === '*' ? [] : [{ clause: `__user = '${persona.id}'` }],
    });
    res.json({ token, expectedTotal: persona.expectedTotal });
  } catch (err) {
    console.error('guest-token error:', err);
    res.status(502).json({ error: 'Failed to mint guest token', detail: String(err) });
  }
});

// Query-log inspection (see README): opens a direct connection to Cube's
// SQL API as the given persona -- same identity model as the pooled
// Superset connection, just without going through Superset -- and runs
// EXPLAIN, which prints Cube's injected filter as part of its query plan.
app.get('/api/explain/:personaId', async (req, res) => {
  const persona = getPersona(req.params.personaId);
  if (!persona) {
    return res.status(400).json({ error: `Unknown persona '${req.params.personaId}'` });
  }

  const client = new pg.Client({
    host: 'cube',
    port: Number(CUBEJS_PG_SQL_PORT),
    user: persona.id,
    password: CUBE_SQL_SHARED_PASSWORD,
    database: 'cube',
  });
  try {
    await client.connect();
    const result = await client.query(
      'EXPLAIN SELECT MEASURE(total_sales_amount) FROM reseller_sales_view'
    );
    // EXPLAIN returns one row per plan stage, shaped {plan_type, plan} --
    // verified against a live instance. This does not include the T-SQL
    // Cube eventually sends to SQL Server (that only appears in Cube's own
    // trace-level container logs: `docker compose logs cube`), only the
    // CubeScan measure/dimension/filter request it compiled from the query.
    res.json({ plan: result.rows.map((row) => `${row.plan_type}:\n${row.plan}`) });
  } catch (err) {
    console.error('explain error:', err);
    res.status(502).json({ error: 'EXPLAIN failed', detail: String(err) });
  } finally {
    await client.end().catch(() => {});
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = Number(BACKEND_PORT || 3001);
app.listen(port, () => {
  console.log(`backend listening on :${port}`);
});

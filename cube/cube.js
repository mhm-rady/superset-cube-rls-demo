// Cube configuration for the Superset + Cube + SQL Server RLS demo.
//
// This file implements the identity side of the two-layer RLS design (see
// the project plan / README "Architecture" section). The actual row FILTER
// is no longer here -- it lives declaratively in
// cube/model/cubes/reseller_sales.yml's access_policy, per Cube's own
// documented recommendation for row-level security (that file's comment
// also covers two hard constraints found live: no cross-cube member
// references in access_policy, and access_policy being a complete no-op
// under CUBEJS_DEV_MODE=true). This file establishes the securityContext
// that policy reads, and the identity-switching rules around it:
//
//   Layer 1 (identity propagation, the real enforcement): Superset's
//   DB_CONNECTION_MUTATOR (superset/superset_config_docker.py) rewrites the
//   Postgres-wire connection username to the current end user's persona id
//   before the connection is even opened. checkSqlAuth below maps that
//   username to a securityContext, and reseller_sales.yml's access_policy
//   reads it to inject the mandatory territory filter. Cube enforces this
//   itself -- a client cannot talk its way out of it.
//
//   Layer 2 (explicit assertion / failure-mode backstop): the guest token's
//   `rls` clause and a native Superset RLS rule both emit
//   `__user = '<persona id>'`, Cube's documented virtual filter for
//   switching the SQL API session's identity mid-connection. canSwitchSqlUser
//   below only allows a "switch" to the identity already on the connection --
//   see that function's comment for why that specific, narrow rule is the
//   point, not an oversight.
//
// Fail-closed by design: an unrecognized username is rejected outright
// (checkSqlAuth throws). See reseller_sales.yml's access_policy comment
// for how the declarative filter behaves if it were ever evaluated with a
// broken/missing security_context -- it can't run unfiltered, only empty.

const fs = require('fs');
const path = require('path');

// Mounted read-only alongside this file -- see docker-compose.yml's `cube`
// service. Single source of truth shared with backend/personas.js; the
// browser never sends a territoryGroup or a SQL fragment, only a persona id.
const personasPath = path.join(__dirname, 'personas.json');
const personasById = Object.fromEntries(
  JSON.parse(fs.readFileSync(personasPath, 'utf8')).personas.map((p) => [p.id, p])
);

// The one shared secret every persona's SQL API connection authenticates
// with. This is safe because identity is carried in the *username*
// (validated against personasById below), not the password -- the password
// only proves "this connection was opened by our own Superset/backend
// instance," not "this connection is entitled to persona X's data."
const sharedPassword = process.env.CUBE_SQL_SHARED_PASSWORD;
if (!sharedPassword) {
  throw new Error('CUBE_SQL_SHARED_PASSWORD is not set -- refusing to start');
}

module.exports = {
  checkSqlAuth: (req, userName, password) => {
    const persona = personasById[userName];
    if (!persona) {
      // Deliberately includes the Superset DB connection's placeholder
      // username ("unscoped_sentinel", see superset/superset_config_docker.py
      // and scripts/bootstrap.mjs). If DB_CONNECTION_MUTATOR ever fails to
      // fire -- e.g. because a request somehow carries an empty username --
      // the connection lands here and is refused outright. That is the
      // fail-closed behavior this design depends on: no persona match means
      // no connection, never "connect anyway with no filter."
      throw new Error('Access denied');
    }

    // `password` is provided only when a NEW connection is established; it
    // is absent on __user switches and on Cube's periodic re-auth
    // (CUBESQL_AUTH_EXPIRE_SECS, default 300s, re-invokes this function on a
    // long-lived pooled connection with no password). Per Cube's own
    // documented contract, only the securityContext matters in that case --
    // this must not throw just because password is missing.
    if (password != null && password !== sharedPassword) {
      throw new Error('Access denied');
    }

    return {
      password,
      securityContext: {
        username: persona.id,
        territoryGroup: persona.territoryGroup,
        // Derived, not just persona.territoryGroup === '*' inline in the
        // YAML: reseller_sales.yml's access_policy conditions run through
        // Cube's single-brace expression parser, which -- confirmed live,
        // not assumed -- rejects `==`/`!=` comparisons outright ("Failed to
        // parse Python expression... Unsupported Python multiple children
        // node: Comp_opContext"). Only boolean logic (`not`/`or`) and bare
        // attribute truthiness are supported there, so the comparison has
        // to happen here instead, in real JS, and be handed over as an
        // already-boolean fact.
        isUnrestricted: persona.territoryGroup === '*',
      },
    };
  },

  // Real per-user identity switching (escalating from one persona to a
  // DIFFERENT persona mid-connection) is never allowed here -- deliberately.
  //
  // The only switch this permits is a no-op: reasserting the identity
  // already on the connection. That covers Layer 2's normal-path use
  // (the guest token's `__user = '<persona>'` clause reasserting the same
  // persona Layer 1 already established), while turning any mismatch --
  // e.g. a connection-pool bug that hands a request the wrong cached
  // connection -- into a hard query failure instead of a silent
  // cross-tenant data leak. That failure mode (loud error beats silent
  // wrong-tenant data) is the entire point of having Layer 2 at all.
  canSwitchSqlUser: (current, next) => current === next,

  // No queryRewrite: the row filter is declared in
  // cube/model/cubes/reseller_sales.yml's access_policy instead. See that
  // file's comment for the reasoning and for the admin ('*') bypass, which
  // is expressed there as a second, mutually-exclusive policy entry rather
  // than an early return here.
};

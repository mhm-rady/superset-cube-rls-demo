// Cube configuration for the Superset + Cube + SQL Server RLS demo.
//
// This file implements the identity side of the RLS design (see the
// project plan / README "Architecture" section). The actual row FILTER is
// not here -- it lives declaratively in cube/model/cubes/reseller_sales.yml's
// access_policy, per Cube's own documented recommendation for row-level
// security (that file's comment also covers two hard constraints found
// live: no cross-cube member references in access_policy, and access_policy
// being a complete no-op under CUBEJS_DEV_MODE=true). This file establishes
// the securityContext that policy reads, and the identity-switching rules
// around it:
//
//   Superset's stored Cube connection authenticates as one fixed,
//   non-privileged identity -- "superset_connection" in personas.json,
//   never a real end user's persona id. checkSqlAuth below maps that
//   username to a securityContext exactly like any other persona, and that
//   persona's territoryGroup ("__no_access__", matching no real territory)
//   means a query against this connection returns zero rows by default.
//
//   Per-request scoping happens entirely through Cube's documented
//   `__user = '<persona id>'` virtual filter -- emitted by the guest
//   token's `rls` clause and by Superset's native RLS rule -- which asks
//   Cube to switch the SQL API session to a different identity mid-
//   connection. canSwitchSqlUser below authorizes that switch ONLY when
//   the connection's current identity is "superset_connection": that fixed
//   identity may become any real persona (each `__user` value still goes
//   through checkSqlAuth's own persona lookup below, so an unrecognized
//   target is rejected there, not here), but no persona may ever switch to
//   a different persona, and nothing may switch to "superset_connection"
//   itself. That is the entire enforcement boundary this file owns: one
//   narrow, auditable class of identity transition, everything else
//   rejected.
//
// Fail-closed by design: an unrecognized username is rejected outright
// (checkSqlAuth throws), and a connection that never gets an authorized
// switch keeps its default zero-row identity rather than falling back to
// anything unrestricted. See reseller_sales.yml's access_policy comment for
// how the declarative filter behaves if it were ever evaluated with a
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

// The one identity Superset's stored Cube connection ever authenticates as
// (see scripts/bootstrap.mjs). Not a real end user -- see personas.json's
// entry for why its own default access is zero rows -- and the only
// identity canSwitchSqlUser (below) allows to become a different persona.
const CONNECTION_IDENTITY_USER = 'superset_connection';

module.exports = {
  checkSqlAuth: (req, userName, password) => {
    const persona = personasById[userName];
    if (!persona) {
      // Covers any username that isn't a real persona and isn't
      // CONNECTION_IDENTITY_USER -- most importantly, an attempted __user
      // switch to an identity that doesn't exist. This is the fail-closed
      // backstop: no persona match means no connection/no switch, never
      // "connect anyway with no filter."
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

  // This is the entire per-request scoping mechanism now that Superset's
  // stored connection always authenticates as CONNECTION_IDENTITY_USER
  // (see that constant's comment): a switch is authorized only when the
  // connection's CURRENT identity is that fixed, non-privileged identity.
  // `next` doesn't need re-validating here -- Cube calls checkSqlAuth again
  // for the target username before this runs (password absent, per the
  // comment above), so an unrecognized `next` is already rejected there.
  //
  // A real persona is never allowed to switch to a DIFFERENT persona (or to
  // CONNECTION_IDENTITY_USER itself) -- only the no-op self-reassertion
  // (current === next) both guest-token and native-RLS re-auth paths rely
  // on. That turns any mismatch -- e.g. a connection-pool bug that hands a
  // request the wrong cached connection -- into a hard query failure
  // instead of a silent cross-tenant data leak.
  canSwitchSqlUser: (current, next) => current === next || current === CONNECTION_IDENTITY_USER,

  // No queryRewrite: the row filter is declared in
  // cube/model/cubes/reseller_sales.yml's access_policy instead. See that
  // file's comment for the reasoning and for the admin ('*') bypass, which
  // is expressed there as a second, mutually-exclusive policy entry rather
  // than an early return here.
};

# Software Architecture

## 1. Introduction

### 1.1 Purpose

This document describes the software architecture of the system: its main
services, the responsibilities each one owns, and the relationships between
them. It is written at the **service/component level** and is deliberately
**infrastructure-agnostic** — it does not assume or prescribe a specific
hosting model, orchestration platform, network topology, or deployment
technology. Any environment capable of running independent network services
and enforcing basic network segmentation can host this architecture.

For a concrete, fully working, verified deployment of this architecture
(specific technology choices, configuration, and infrastructure), see the
project's `README.md`. For the detailed mechanics of the security-context
propagation model summarized in §6.1, see `docs/RLS-CONFIGURATION.md`.

### 1.2 Scope

In scope: the system's main services, their responsibilities, the protocols
and data that flow between them, and the cross-cutting concerns (security,
scalability, resilience, observability) that shape how they must be built
and operated.

Out of scope: infrastructure and deployment topology (compute, networking,
orchestration), end-user identity/authentication mechanism (this
architecture consumes an established caller identity; it does not define
how that identity is first authenticated), and the analytical data model
itself.

### 1.3 Architectural Style

The system is a **data-access mediation architecture**: a chain of
purpose-built services sits between an end user and an analytical data
store, where **exactly one service in the chain is the authoritative
enforcement point for data access control**, and every other service is
either a pass-through, a convenience layer, or a defense-in-depth backstop.
This is the central design decision the rest of this document elaborates:
enforcement is centralized and auditable in one place, not distributed
(and therefore duplicated, and therefore prone to drift) across every
service that happens to touch the data.

---

## 2. System Context

```
                                   ┌───────────────────────┐
                                   │        End User         │
                                   │       (Browser)          │
                                   └────────────┬─────────────┘
                                                │  HTTPS
                                                ▼
                      ┌─────────────────────────────────────────────────┐
                      │                Client Application                 │
                      │                 (Web Frontend)                     │
                      └───────────┬─────────────────────────┬─────────────┘
                                  │                           │
                     HTTPS/REST  │                           │  HTTPS
              (request a scoped  │                           │  (render dashboard,
               session token)    │                           │   issue queries)
                                  ▼                           ▼
              ┌───────────────────────────┐   HTTPS/REST   ┌───────────────────────────┐
              │     Application Backend      │ ─────────────► │  BI / Visualization         │
              │   (Identity / Token Broker)   │ ◄───────────── │       Platform                │
              └───────────────────────────┘  (privileged     └──────────────┬───────────────┘
                                              service session)               │
                                                                              │ SQL-compatible
                                                                              │ query protocol
                                                                (connection identity
                                                                 = caller identity)
                                                                              ▼
                                                              ┌───────────────────────────┐
                                                              │  Semantic Layer /            │
                                                              │  Query Engine                  │
                                                              │  (access-control              │
                                                              │   enforcement point)           │
                                                              └──────────────┬───────────────┘
                                                                              │ native data-source
                                                                              │ protocol
                                                                              ▼
                                                              ┌───────────────────────────┐
                                                              │       Data Warehouse         │
                                                              └───────────────────────────┘
```

Five main services participate in the system. Two supporting categories of
state store (§4) are omitted from this diagram for clarity.

---

## 3. Service Catalog

### 3.1 Client Application

**Responsibility.** The end-user-facing surface. Establishes which caller
identity is active, requests a scoped session on that identity's behalf,
and renders the analytical dashboard the BI Platform serves.

| | |
|---|---|
| **Consumes** | Application Backend (session token request); BI Platform (dashboard render, embedded-SDK or equivalent) |
| **Owns** | No durable state. Holds only the current session token in memory/short-lived client storage. |
| **Trust level** | Untrusted. Runs in an environment (the browser) the system does not control. Must never hold a credential more privileged than a single-identity, time-boxed session token. |
| **Key constraint** | Requests a **fresh token on every identity change** — never caches or reuses a token across different callers. Has no code path capable of constructing or transmitting a raw access-control predicate; it transmits an opaque identity reference only. |

### 3.2 Application Backend (Identity / Token Broker)

**Responsibility.** The single trust boundary between the untrusted client
and the BI Platform's administrative surface. Resolves a client-supplied
identity reference to a full identity, and exchanges it — using its own
privileged, backend-only session — for a session token scoped to exactly
that one identity and exactly the resource(s) it is allowed to reach.

| | |
|---|---|
| **Exposes** | A minimal REST surface: identity lookup, token issuance, optional diagnostic/inspection endpoints |
| **Consumes** | BI Platform's administrative API (privileged session) |
| **Owns** | The authoritative identity list (or a reference to one) — who exists, and what caller identity string represents them. Holds the one privileged credential in the system with administrative reach into the BI Platform. |
| **Trust level** | Trusted, backend-only. Never reachable from an untrusted network except through the narrow API it exposes. |
| **Key constraints** | Never accepts anything from the client except an opaque identity reference; resolves attributes/entitlements server-side. Refreshes its own privileged session on expiry rather than assuming a single login lasts the process's lifetime — this service is expected to run continuously, unlike a one-shot setup task. |

### 3.3 BI / Visualization Platform

**Responsibility.** Hosts dashboards and their chart definitions, manages
the datasets they're built on, authenticates dashboard viewers (whether via
a scoped session token or a native login), and issues the underlying data
queries those dashboards require. Provides a **backstop** access-control
rule as defense-in-depth, but is **not** the system's authoritative
enforcement point (§3.4 is).

| | |
|---|---|
| **Exposes** | Dashboard rendering/embedding surface (browser-facing); an administrative API (backend-facing, privileged) |
| **Consumes** | Semantic Layer (query execution) |
| **Owns** | Dashboard, chart, and dataset definitions; its own configuration/metadata state (§4.1); a role model distinguishing privileged/administrative access from scoped viewer access |
| **Trust level** | Semi-trusted. Terminates the caller's session token and must map it to a **least-privilege role** — never the platform's default anonymous/public role, which typically carries grants meant for unauthenticated visitors. |
| **Key constraints** | On every query it issues downstream, the connection's identity must be rewritten to the current caller's identity **before the query is sent** — this is what makes per-caller enforcement possible at all at the layer below. Any role capable of reaching an unmediated query interface (e.g., an ad-hoc SQL console) bypasses this system's access control entirely and must be excluded from caller-facing roles. |

### 3.4 Semantic Layer / Query Engine

**Responsibility.** The **authoritative enforcement point**. Exposes a
governed, SQL-compatible query interface; maps every incoming connection's
identity to a security context; and injects the mandatory access-control
predicate into every compiled query before it reaches the warehouse. This
is the one component in the system that cannot be talked out of enforcing
access control by a misbehaving caller upstream.

| | |
|---|---|
| **Exposes** | A SQL-compatible query protocol, keyed by per-connection identity |
| **Consumes** | Data Warehouse (native protocol) |
| **Owns** | The declarative access-control policy; the identity → security-context mapping (or a reference to the same identity source the Application Backend uses); the semantic/analytical data model |
| **Trust level** | Trusted, backend-only. Never reachable directly from the client or from any untrusted network. |
| **Key constraints** (see `docs/RLS-CONFIGURATION.md` for the full mechanics) | Rejects any unrecognized caller identity outright — **fails closed**, never falls back to an unfiltered default. Treats any shared connection secret as proof of *origin* only, never of *entitlement* — entitlement is derived solely from the validated identity. Does not permit a connection to switch to a different identity mid-session (only a no-op reassertion of its own identity), so a connection-pooling defect becomes a hard error rather than a silent cross-identity leak. |

### 3.5 Data Warehouse

**Responsibility.** System of record for the analytical data. Executes the
governed queries the Semantic Layer compiles and sends it.

| | |
|---|---|
| **Exposes** | Its native data-access protocol, to the Semantic Layer only |
| **Consumes** | Nothing upstream of it in this architecture |
| **Owns** | The analytical data itself |
| **Trust level** | Trusted, backend-only, single consumer. |
| **Key constraint** | Is never queried directly by the BI Platform, the Application Backend, or the Client Application. Every query it executes has already had the mandatory access predicate applied by the Semantic Layer — the warehouse itself does not need to be, and should not be relied on to be, RLS-aware. |

---

## 4. Supporting State Stores

Not "main" services in the request-handling path, but required operational
dependencies of the services above. Named here by role, not by product,
since the architecture does not prescribe a specific technology for any of
them.

| Store | Owned by | Purpose |
|---|---|---|
| **Metadata / configuration store** | BI Platform | Persists dashboard, chart, dataset, role, and connection definitions. A relational store is typical; the requirement is durability and transactional consistency, not a specific product. |
| **Cache** | BI Platform | Session and query-result caching. Optional for correctness, load-bearing for latency and for reducing redundant load on the Semantic Layer. |
| **Analytical acceleration store** | Semantic Layer | Materializations/pre-aggregations the Semantic Layer uses to answer queries without hitting the warehouse every time. **Must not be populated for any data subject to per-caller access control unless the refresh process itself carries a valid security context** — a scheduled background refresh typically does not, which is why access-controlled analytical models frequently define no materializations at all rather than risk building an unfiltered one. |

---

## 5. Interaction Views

### 5.1 Session / Identity Establishment

```
End User        Client App        App Backend        BI Platform
   │                 │                  │                  │
   │  select/hold    │                  │                  │
   │  an identity     │                  │                  │
   │────────────────►│                  │                  │
   │                 │  request token   │                  │
   │                 │  (identity ref)   │                  │
   │                 │─────────────────►│                  │
   │                 │                  │  privileged      │
   │                 │                  │  admin session   │
   │                 │                  │─────────────────►│
   │                 │                  │  scoped session  │
   │                 │                  │  token, bound to │
   │                 │                  │  one identity +  │
   │                 │                  │  one resource    │
   │                 │                  │◄─────────────────│
   │                 │  scoped token    │                  │
   │                 │◄─────────────────│                  │
```

The Application Backend's privileged admin session is established once and
reused across requests (refreshed on expiry) — it is not re-authenticated
per user request. What *is* per-request is the scoped token: exactly one
identity, exactly one resource, short-lived.

### 5.2 Dashboard Render & Query Execution

```
Client App        BI Platform        Semantic Layer        Data Warehouse
    │                   │                    │                    │
    │  render dashboard │                    │                    │
    │  (scoped token)    │                    │                    │
    │──────────────────►│                    │                    │
    │                   │  resolve token →   │                    │
    │                   │  caller identity,  │                    │
    │                   │  least-privilege   │                    │
    │                   │  role              │                    │
    │                   │                    │                    │
    │                   │  per chart: issue  │                    │
    │                   │  query; connection │                    │
    │                   │  identity rewritten │                    │
    │                   │  to caller identity │                    │
    │                   │───────────────────►│                    │
    │                   │                    │  identity →        │
    │                   │                    │  security context  │
    │                   │                    │  → mandatory        │
    │                   │                    │  predicate injected │
    │                   │                    │  into compiled query│
    │                   │                    │───────────────────►│
    │                   │                    │  filtered results   │
    │                   │                    │◄───────────────────│
    │                   │  results            │                    │
    │                   │◄───────────────────│                    │
    │  rendered charts  │                    │                    │
    │◄──────────────────│                    │                    │
```

Two independent checks are visible in this flow, by design: the BI
Platform's own backstop rule (re-asserting the caller identity on every
request, evaluated at render time) and the Semantic Layer's mandatory
predicate (the actual enforcement, evaluated at query-compile time). In the
normal path they agree and the backstop is redundant. Its value is in the
failure path — see §6.4.

---

## 6. Cross-Cutting Concerns

### 6.1 Security & Access-Control Propagation

The system's core security property: **caller identity travels with every
request as an opaque reference, and is resolved to an access-control
predicate exactly once, at the Semantic Layer** — never earlier, and never
by trusting a value the client or an intermediate service supplied. Every
service upstream of the Semantic Layer either passes an identity reference
through unchanged or re-derives it from its own trusted source (a session
token, an authenticated login) — none of them constructs or forwards a
filter value, a predicate, or a raw entitlement.

This document describes the *shape* of that propagation; the full
mechanics — the specific hooks, the fail-closed behavior at each layer, and
the two supported identity-handover patterns (embedded/token-based and
direct/native login) — are specified in `docs/RLS-CONFIGURATION.md`.

### 6.2 Trust Boundaries

Two zones, independent of how they're physically implemented:

- **Untrusted zone** — the Client Application only. Nothing in this zone
  holds a credential more privileged than a single-identity, time-boxed
  session token.
- **Trusted zone** — the Application Backend, BI Platform, Semantic Layer,
  and Data Warehouse. Only the Application Backend holds administrative
  credentials into the BI Platform; only the BI Platform and Semantic
  Layer share the narrow connection credential between them; only the
  Semantic Layer holds credentials into the Data Warehouse.

Whatever network implements this system, only the Client Application (and,
where the BI Platform renders directly to the browser, its render/embed
endpoint) should be reachable from an untrusted network. Every other
service-to-service edge belongs entirely inside the trusted zone.

### 6.3 Scalability

- The **Client Application** and **Application Backend** are stateless
  (aside from the Backend's own cached privileged session) and scale
  horizontally without coordination.
- The **BI Platform** and **Semantic Layer** carry state (metadata, cache,
  materializations) that must be externalized/shared for either to scale
  beyond a single instance.
- The **Data Warehouse** is the system's ultimate throughput bound; the
  Semantic Layer's acceleration store (§4) exists specifically to reduce
  load on it, subject to the access-control constraint noted there.

### 6.4 Resilience & Failure Modes

Every layer in the enforcement chain is designed to **fail closed**:

- An unrecognized caller identity is rejected outright at the Semantic
  Layer, never passed through with a default or unrestricted scope.
- A connection whose identity does not match what it attempts to assert
  mid-session is rejected as a hard error, not silently corrected — this
  is precisely the case the BI Platform's backstop rule (§3.3, §5.2) is
  designed to surface: a connection-pooling defect or misconfiguration
  becomes a loud failure instead of a silent cross-identity data leak.
- A missing caller identity at the propagation point (§6.1) must leave the
  connection in a state the Semantic Layer itself rejects — never default
  to a privileged or service-level identity.

### 6.5 Observability

The Semantic Layer's query log/trace is the system's **source of truth**
for verifying that access control was actually applied to a given
request — it is the only point in the chain where the compiled predicate
is directly visible. Application-level logs upstream of it can confirm a
request *was made*; only the Semantic Layer's own trace confirms what was
*enforced*. Any audit or verification process should treat it accordingly,
and a correlation identifier threaded through the chain (client request →
backend → BI Platform → Semantic Layer) makes that trace attributable to a
specific end-user action.

### 6.6 Configuration & Secrets Management

Infrastructure-agnostic by design: this architecture does not prescribe
*where* secrets are stored (environment variables, a secrets manager, a
vault service). It does constrain *which service may hold which secret*:

- The Application Backend is the only service holding administrative
  credentials into the BI Platform.
- The BI Platform and Semantic Layer share only a narrowly-scoped
  connection credential that proves the connection's origin — never a
  credential that by itself proves entitlement to any specific caller's
  data (§3.4).
- The Semantic Layer alone holds credentials into the Data Warehouse.

---

## 7. Quality Attribute Priorities

| Attribute | Priority | Primary mechanism |
|---|---|---|
| **Security** (access-control correctness) | Primary driver | Single authoritative enforcement point (§3.4), fail-closed at every layer (§6.4), least-privilege credentials per service (§6.2, §6.6) |
| **Auditability** | High | Query-level trace as source of truth (§6.5) |
| **Scalability** | Medium | Statelessness of client-facing services; externalized state for the rest (§6.3) |
| **Availability** | Medium | Independently deployable/restartable services; no single service other than the Data Warehouse is a hard single point of failure by architecture (specific redundancy is a deployment concern, out of scope here) |
| **Maintainability** | Medium | Clear separation of concerns per service (§3); a change to the access-control policy touches the Semantic Layer only |

---

## 8. Constraints & Assumptions

- Assumes an established, stable caller identity reaches the Client
  Application by some means (an external identity provider, an
  application-level login, an operator-provisioned identity list) — how
  that identity is first authenticated is out of this architecture's
  scope.
- Assumes the BI Platform supports **some** mechanism for propagating a
  per-caller identity into the connection it uses to query the Semantic
  Layer. A BI Platform with no such mechanism, and no native backstop rule,
  cannot support this architecture without redesign.
- Assumes the Semantic Layer supports a per-connection identity/security-
  context model and a declarative or programmatic access-control policy
  evaluated on every query. A query engine that only enforces access
  control at the schema/column level, not the row level, satisfies part of
  this architecture but not the RLS mechanics referenced in §6.1.
- Deliberately silent on deployment topology: process boundaries, compute
  model, network implementation, and redundancy strategy are all left to
  the deploying environment. See the project's own deployment
  configuration for one concrete, fully verified instance of this
  architecture.

---

## 9. Glossary

| Term | Definition |
|---|---|
| **Caller identity** | The opaque reference identifying who a request is on behalf of, carried end-to-end through the system. Never a filter value or predicate itself. |
| **Security context** | The resolved set of attributes the Semantic Layer derives from a caller identity, used to compile the mandatory access-control predicate. |
| **Backstop rule** | A redundant, defense-in-depth access-control check at the BI Platform, valuable specifically in the failure path (§6.4), not the primary enforcement mechanism. |
| **Fail closed** | The design principle that any missing, invalid, or unrecognized identity results in denied/empty access — never in unfiltered/default access. |
| **Scoped session token** | A short-lived credential the Application Backend issues, bound to exactly one caller identity and one resource. |

---

## 10. Related Documents

- `README.md` — a concrete, fully working, automated-tested instance of
  this architecture, including specific technology choices and verified
  end-to-end results.
- `docs/RLS-CONFIGURATION.md` — the detailed, deployment-agnostic
  configuration reference for the access-control propagation model
  summarized in §6.1.

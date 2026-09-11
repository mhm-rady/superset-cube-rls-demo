# Superset config for the Superset + Cube + SQL Server RLS demo.
#
# Loaded via the SUPERSET_CONFIG_PATH env var (see docker-compose.yml),
# NOT via the docker/pythonpath_dev/superset_config_docker.py convention
# described in Superset's own dev docker-compose files -- that convention
# only applies to an image BUILT from the Superset repo's docker-compose-*
# flow, which bakes docker/pythonpath_dev/superset_config.py into the
# image. The plain published `apache/superset:6.1.0` tag does not contain
# that file at all (confirmed by exec'ing into the running container), so
# this file is fully self-contained: it also does the Postgres/Redis wiring
# that missing base file would otherwise have provided, not just the
# RLS-specific overrides.
#
# This file implements Layer 1 of the two-layer RLS design -- see
# cube/cube.js for Layer 2 and the full picture, and the project README for
# the end-to-end walkthrough.

import os

# ---------------------------------------------------------------------------
# Metadata database + cache (normally provided by the base image's own
# docker/pythonpath_dev/superset_config.py -- written out explicitly here
# because that file does not exist in this image; see note above).
# ---------------------------------------------------------------------------
SQLALCHEMY_DATABASE_URI = (
    f"{os.environ['DATABASE_DIALECT']}://"
    f"{os.environ['DATABASE_USER']}:{os.environ['DATABASE_PASSWORD']}@"
    f"{os.environ['DATABASE_HOST']}:{os.environ['DATABASE_PORT']}/{os.environ['DATABASE_DB']}"
)

REDIS_HOST = os.environ.get("REDIS_HOST", "superset-redis")
REDIS_PORT = os.environ.get("REDIS_PORT", "6379")
CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "superset_",
    "CACHE_REDIS_HOST": REDIS_HOST,
    "CACHE_REDIS_PORT": REDIS_PORT,
    "CACHE_REDIS_DB": 1,
}
DATA_CACHE_CONFIG = CACHE_CONFIG
# No CELERY_CONFIG: this demo deliberately runs no worker/beat service (see
# docker-compose.yml), so nothing would ever consume a Celery broker/result
# backend. Async SQL Lab and scheduled reports are both out of scope here.

# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------
FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    # Needed for the native RLS backstop rule's Jinja clause
    # (`__user = '{{ current_username() }}'`) -- see scripts/bootstrap.mjs.
    "ENABLE_TEMPLATE_PROCESSING": True,
}

# NOT the "Public" default: that role is also the permission set applied to
# anonymous, unauthenticated visitors, so anything granted to it for
# embedding would leak to them too. The guest token's `rls` clause only
# NARROWS what a guest can see -- it grants nothing -- so this role must
# itself carry read access to the Cube-backed dataset in scripts/bootstrap.mjs,
# and deliberately no SQL Lab access (SQL Lab bypasses dataset-level RLS
# entirely; see the README's "honest boundary" section).
GUEST_ROLE_NAME = "Embedded"

GUEST_TOKEN_JWT_SECRET = os.environ["GUEST_TOKEN_JWT_SECRET"]
GUEST_TOKEN_JWT_ALGO = "HS256"
# Left at its default (derived from the minting request's Host header),
# this came back as "http://0.0.0.0:8080/" in this Gunicorn setup --
# neither the internal (http://superset:8088, where the backend mints
# tokens from) nor the public (http://localhost:8088, where the browser
# later presents them) URL. Since a mismatched `aud` fails verification at
# presentation time, pin it explicitly to the one URL that actually matters:
# where the browser will present the token.
GUEST_TOKEN_JWT_AUDIENCE = os.environ.get("SUPERSET_PUBLIC_URL", "http://localhost:8088")
GUEST_TOKEN_HEADER_NAME = "X-GuestToken"
GUEST_TOKEN_JWT_EXP_SECONDS = 300

FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000")

# 6.x flips this default to True with its own non-empty CORS_OPTIONS
# containing the OpenStreetMap tile origins (map charts break if a fresh
# dict silently drops them) -- extend that default rather than replace it.
ENABLE_CORS = True
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": ["*"],
    "resources": ["*"],
    "origins": [
        FRONTEND_ORIGIN,
        "https://tile.openstreetmap.org",
        "https://tile.osm.ch",
    ],
    "expose_headers": ["ETag"],
}

# flask-talisman's own default is `frame_options=SAMEORIGIN`, and Superset's
# base config never overrides it -- so every response carries
# `X-Frame-Options: SAMEORIGIN` regardless of what `frame-ancestors` below
# says, and the embedded iframe stays blank. `frame_options: None` is the
# fix; do NOT try to fix this via HTTP_HEADERS instead -- that dict is
# appended to the response, not substituted, so it produces a SECOND,
# conflicting X-Frame-Options header and browsers deny on conflict.
#
# Superset's own initializer picks ONE of TWO separate config variables --
# TALISMAN_DEV_CONFIG when `app.debug` (true here: FLASK_DEBUG=true) is set,
# TALISMAN_CONFIG otherwise -- confirmed by reading
# superset/initialization/__init__.py directly, after finding that setting
# only TALISMAN_CONFIG had no visible effect on a live response (curl still
# showed X-Frame-Options: SAMEORIGIN and no frame-ancestors). Assign the
# SAME dict to both names so this is correct regardless of debug mode,
# rather than relying on FLASK_DEBUG never changing.
TALISMAN_ENABLED = True
_TALISMAN_CONFIG = {
    "content_security_policy": {
        "base-uri": ["'self'"],
        "default-src": ["'self'"],
        "img-src": ["'self'", "blob:", "data:"],
        "worker-src": ["'self'", "blob:"],
        "connect-src": ["'self'", "https://tile.openstreetmap.org", "https://tile.osm.ch"],
        "object-src": "'none'",
        "style-src": ["'self'", "'unsafe-inline'"],
        "script-src": ["'self'", "'strict-dynamic'"],
        "frame-ancestors": ["'self'", FRONTEND_ORIGIN],
    },
    "content_security_policy_nonce_in": ["script-src"],
    "force_https": False,  # plain http://localhost for this demo
    "session_cookie_secure": False,
    "frame_options": None,  # <-- the fix described above; do not remove
}
TALISMAN_CONFIG = _TALISMAN_CONFIG
TALISMAN_DEV_CONFIG = _TALISMAN_CONFIG

# The documented cross-origin embedding recipe (SESSION_COOKIE_SAMESITE =
# "None" + SESSION_COOKIE_SECURE = True) requires HTTPS and is rejected by
# every modern browser on http://localhost. Left at the framework default
# (Lax) deliberately: guest-token auth travels in the X-GuestToken header,
# not the session cookie, so embedding does not need it changed here.

# ---------------------------------------------------------------------------
# Allow Superset to connect to the Cube container at all.
#
# Superset's SSRF guard (on by default since 2.1) blocks SQLAlchemy
# connections whose resolved host falls in a private/link-local IP range.
# The Docker bridge network's `cube` service resolves to exactly such an
# address, so the guard would otherwise block Superset -> Cube outright.
# This is the correct call ONLY because both containers sit on a private
# compose network with no untrusted DNS in between; do not carry this
# setting into a deployment where Superset's network is not fully trusted.
# ---------------------------------------------------------------------------
PREVENT_UNSAFE_DB_CONNECTIONS = False

# No DB_CONNECTION_MUTATOR here: Superset's stored Cube connection now
# authenticates as one fixed identity ("superset_connection" in
# personas.json, provisioned by scripts/bootstrap.mjs) rather than having
# its username rewritten per end user. Per-request scoping happens entirely
# through the native RLS rule's `__user` clause, authorized in
# cube/cube.js's canSwitchSqlUser -- see that file for the full mechanism.

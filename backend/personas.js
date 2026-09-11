// Reads the project's single source of truth for RLS personas. Shared with
// cube/cube.js -- see docker-compose.yml for how personas.json is mounted
// into both containers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const personasPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'personas.json');
const personas = JSON.parse(readFileSync(personasPath, 'utf8')).personas;
const byId = new Map(personas.map((p) => [p.id, p]));

/**
 * Persona list for the frontend's switcher UI. Deliberately omits
 * territoryGroup -- that's the exact filter value the reseller_sales
 * cube's access_policy applies (cube/model/cubes/reseller_sales.yml), and
 * the browser has no legitimate use for it. The browser only
 * ever sends a persona *id* (see server.js's /api/guest-token), so a
 * compromised or buggy frontend cannot request a scope it doesn't already
 * have server-side.
 *
 * Also excludes any `internal` entry -- personas.json's
 * "superset_connection" is not a real end user, just the fixed identity
 * Superset's Cube connection authenticates as (see cube/cube.js); it must
 * never be offered as something a browser can select.
 */
export function listPersonas() {
  return personas
    .filter((p) => !p.internal)
    .map(({ id, displayName, description, expectedTotal }) => ({
      id,
      displayName,
      description,
      expectedTotal,
    }));
}

export function getPersona(id) {
  return byId.get(id);
}

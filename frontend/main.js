// Hop 1 and hop 3 of the RLS handover (see README): this page asks our own
// backend for a guest token per persona (hop 1->2), then hands that token
// to the Superset embedded SDK, which uses it to authenticate the iframe's
// requests directly to Superset (hop 3). Everything after the iframe loads
// -- Superset's own RLS, Cube's securityContext, the SQL Server query --
// happens entirely outside this page's control, which is the point: a
// compromised or buggy frontend cannot widen what a persona can see.
import { embedDashboard } from '@superset-ui/embedded-sdk';

const state = {
  personas: [],
  currentPersonaId: null,
  embedConfig: null, // { dashboardUuid, supersetPublicUrl } -- fetched once, cached
};

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && (data.error || data.detail)) || `${url} -> HTTP ${res.status}`);
  }
  return data;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

async function getEmbedConfig() {
  if (!state.embedConfig) {
    state.embedConfig = await fetchJson('/api/embed-config');
  }
  return state.embedConfig;
}

function renderSwitcher() {
  const container = document.getElementById('persona-switcher');
  container.innerHTML = '<h2>Choose a persona</h2>';

  const list = document.createElement('div');
  list.className = 'persona-list';
  for (const persona of state.personas) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'persona-button';
    button.dataset.personaId = persona.id;
    button.innerHTML = `
      <span class="persona-name">${persona.displayName}</span>
      <span class="persona-description">${persona.description}</span>
    `;
    button.addEventListener('click', () => selectPersona(persona.id));
    list.appendChild(button);
  }
  container.appendChild(list);
}

function highlightActivePersona() {
  document.querySelectorAll('.persona-button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.personaId === state.currentPersonaId);
  });
}

async function selectPersona(personaId) {
  state.currentPersonaId = personaId;
  highlightActivePersona();

  const persona = state.personas.find((p) => p.id === personaId);
  document.getElementById('expected-total').textContent = persona
    ? formatCurrency(persona.expectedTotal)
    : '–';

  const explainOutput = document.getElementById('explain-output');
  explainOutput.textContent = 'Click "Run EXPLAIN" to inspect this persona\'s query plan.';
  document.getElementById('explain-button').disabled = false;

  await embedForPersona(personaId);
}

async function fetchGuestToken(personaId) {
  const data = await fetchJson('/api/guest-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaId }),
  });
  return data.token;
}

async function embedForPersona(personaId) {
  const mountPoint = document.getElementById('superset-embed');
  mountPoint.innerHTML = '<p class="loading">Loading dashboard&hellip;</p>';

  try {
    const { dashboardUuid, supersetPublicUrl } = await getEmbedConfig();
    // Each persona switch calls fetchGuestToken again and mints a FRESH
    // token server-side (backend/server.js) -- this is exactly the
    // "different end user requests the dashboard" case the native RLS
    // rule's __user switch (cube/cube.js's canSwitchSqlUser) is designed
    // around, not a simulated shortcut.
    await embedDashboard({
      id: dashboardUuid,
      supersetDomain: supersetPublicUrl,
      mountPoint,
      fetchGuestToken: () => fetchGuestToken(personaId),
      dashboardUiConfig: {
        hideTitle: true,
        filters: { expanded: false },
      },
    });
  } catch (err) {
    mountPoint.innerHTML = `<p class="error">Failed to embed dashboard: ${escapeHtml(err.message)}</p>`;
    console.error(err);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function runExplain() {
  if (!state.currentPersonaId) return;
  const output = document.getElementById('explain-output');
  output.textContent = 'Running...';
  try {
    const data = await fetchJson(`/api/explain/${encodeURIComponent(state.currentPersonaId)}`);
    output.textContent = (data.plan || []).join('\n');
  } catch (err) {
    output.textContent = `Failed: ${err.message}`;
  }
}

async function init() {
  document.getElementById('explain-button').addEventListener('click', runExplain);
  try {
    state.personas = await fetchJson('/api/personas');
    renderSwitcher();
  } catch (err) {
    document.getElementById('persona-switcher').innerHTML =
      `<p class="error">Failed to load personas: ${escapeHtml(err.message)}</p>`;
  }
}

init();

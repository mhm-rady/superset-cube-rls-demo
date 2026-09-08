import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Keeps every browser -> backend call same-origin during dev (the
      // page is served from :3000, and /api/* is transparently forwarded
      // to the backend container). This sidesteps a whole class of CORS
      // bugs for this hop entirely; the backend's own CORS headers
      // (backend/server.js) remain in place as defense-in-depth for anyone
      // who calls it directly instead of through this proxy.
      '/api': {
        target: 'http://backend:3001',
        changeOrigin: true,
      },
    },
  },
});

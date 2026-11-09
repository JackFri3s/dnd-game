import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

// `npm run dev` runs the web app and the Cloudflare game server together.
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: { host: true }, // reachable from phones on the same Wi-Fi during development
});

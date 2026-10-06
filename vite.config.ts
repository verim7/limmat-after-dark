import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

// The Cloudflare plugin runs worker/index.ts inside workerd during `npm run dev`,
// so the API, D1 and secrets behave the same locally as in production.
export default defineConfig({
  plugins: [react(), cloudflare()],
})

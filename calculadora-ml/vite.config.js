import 'dotenv/config'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { apiPlugin } from './server/vite-plugin-api.js'

// O apiPlugin embute um mini-backend dentro do próprio servidor do Vite.
// Ele roda no Node (lado servidor), então pode guardar o client_secret e
// falar com a API do Mercado Livre sem esbarrar em CORS.
export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    port: 5173,
    strictPort: true, // não muda de porta — a redirect_uri do ML precisa bater exatamente
  },
})

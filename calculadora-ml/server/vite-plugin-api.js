import { handleApi } from './api-handler.js'

// Embute o mini-backend dentro do dev-server do Vite (roda no Node).
// A lógica das rotas fica em api-handler.js, compartilhada com o
// servidor de produção (server.js).
export function apiPlugin() {
  return {
    name: 'ml-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const handled = await handleApi(req, res)
        if (!handled) next()
      })
    },
  }
}

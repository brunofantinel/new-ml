import { authStatus, getFees, predictCategory, buildAuthUrl, exchangeCode } from './ml.js'

// Handler compartilhado das rotas /api/* e /callback.
// Usado tanto pelo dev-server do Vite (vite-plugin-api.js) quanto pelo
// servidor de produção (server.js). Retorna true se tratou a requisição.
export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  if (path !== '/callback' && !path.startsWith('/api/')) return false

  try {
    if (path === '/api/auth/login') {
      res.statusCode = 302
      res.setHeader('Location', buildAuthUrl())
      res.end()
      return true
    }
    if (path === '/callback') {
      const code = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      if (err) { html(res, `<h2>Erro do Mercado Livre: ${err}</h2><p>${url.searchParams.get('error_description') || ''}</p><a href="/">voltar</a>`); return true }
      if (!code) { html(res, '<h2>Faltou o code na volta do ML.</h2><a href="/">voltar</a>'); return true }
      await exchangeCode(code)
      html(res, '<h2>✅ Vendedor conectado!</h2><p>Pode fechar esta aba e voltar para o app.</p><a href="/">abrir o app</a>')
      return true
    }
    if (path === '/api/auth/status') { json(res, authStatus()); return true }
    if (path === '/api/predict-category') { json(res, await predictCategory(url.searchParams.get('q') || '')); return true }
    if (path === '/api/fees') { json(res, await getFees(Object.fromEntries(url.searchParams))); return true }
    return false
  } catch (e) {
    res.statusCode = e.status || 500
    json(res, { error: e.message, detail: e.data || null })
    return true
  }
}

function json(res, obj) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}
function html(res, body) {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem;max-width:40rem;margin:auto">${body}</body>`)
}

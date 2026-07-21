import 'dotenv/config'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { handleApi } from './api-handler.js'

// Servidor de produção: serve o build estático (dist/) e trata as rotas
// /api/* e /callback reaproveitando o mesmo handler do dev-server.
const DIST = path.resolve(process.cwd(), 'dist')
const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST || '0.0.0.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

const server = http.createServer(async (req, res) => {
  // Healthcheck simples (útil pro easypanel)
  if (req.url === '/healthz') { res.statusCode = 200; return res.end('ok') }

  const handled = await handleApi(req, res)
  if (handled) return

  const url = new URL(req.url, 'http://localhost')
  const rel = decodeURIComponent(url.pathname)
  let filePath = path.join(DIST, rel)

  // Barra path traversal (../) pra fora do dist
  if (!filePath.startsWith(DIST)) {
    res.statusCode = 403
    return res.end('forbidden')
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) return sendFile(res, filePath)
    // SPA fallback: qualquer rota desconhecida devolve o index.html
    sendFile(res, path.join(DIST, 'index.html'))
  })
})

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase()
  res.setHeader('content-type', MIME[ext] || 'application/octet-stream')
  fs.createReadStream(filePath)
    .on('error', () => { res.statusCode = 500; res.end('erro ao ler arquivo') })
    .pipe(res)
}

server.listen(PORT, HOST, () => {
  console.log(`calculadora-ml em producao: http://${HOST}:${PORT}`)
  if (!fs.existsSync(DIST)) {
    console.warn('AVISO: pasta dist/ nao encontrada. Rode "npm run build" antes de iniciar.')
  }
})

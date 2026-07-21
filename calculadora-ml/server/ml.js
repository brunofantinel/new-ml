import fs from 'node:fs'
import path from 'node:path'
import { estimarFrete } from './freight.js'

const API = 'https://api.mercadolibre.com'
const AUTH = 'https://auth.mercadolivre.com.br'
const USER_TOKEN_FILE = path.resolve(process.cwd(), '.user-token.json')
const redirectUri = () => process.env.ML_REDIRECT_URI || ''

// ===========================================================================
// Dois modos de token:
//  - App token (client_credentials): sempre disponível, só com ID+Secret.
//  - Token de vendedor (authorization_code): opcional, destrava dados como o
//    preço do concorrente (buy box). Quando existe, tem prioridade.
// ===========================================================================

// ---------- App token (client_credentials) ----------
let appCache = null
async function getAppToken() {
  if (appCache && Date.now() < appCache.expires_at - 60_000) return appCache.token
  if (!process.env.ML_CLIENT_ID || !process.env.ML_CLIENT_SECRET) {
    throw Object.assign(new Error('sem_credenciais'), { status: 401 })
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
  })
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const d = await r.json()
  if (!r.ok) throw Object.assign(new Error('auth_failed'), { status: r.status, data: d })
  appCache = { token: d.access_token, expires_at: Date.now() + d.expires_in * 1000 }
  return appCache.token
}

// ---------- Token de vendedor (authorization_code) ----------
function readUserToken() {
  try { return JSON.parse(fs.readFileSync(USER_TOKEN_FILE, 'utf8')) } catch { return null }
}
function writeUserToken(d) {
  fs.writeFileSync(USER_TOKEN_FILE, JSON.stringify({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    user_id: d.user_id,
    expires_at: Date.now() + d.expires_in * 1000,
  }, null, 2))
}

export function buildAuthUrl() {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ML_CLIENT_ID || '',
    redirect_uri: redirectUri(),
  })
  return `${AUTH}/authorization?${p.toString()}`
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ML_CLIENT_ID || '',
    client_secret: process.env.ML_CLIENT_SECRET || '',
    code,
    redirect_uri: redirectUri(),
  })
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const d = await r.json()
  if (!r.ok) throw Object.assign(new Error('oauth_failed'), { status: r.status, data: d })
  writeUserToken(d)
  return d
}

async function getUserToken() {
  const t = readUserToken()
  if (!t) return null
  if (Date.now() < t.expires_at - 60_000) return t.access_token
  // renova
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID || '',
      client_secret: process.env.ML_CLIENT_SECRET || '',
      refresh_token: t.refresh_token,
    })
    const r = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const d = await r.json()
    if (!r.ok) return null
    writeUserToken(d)
    return d.access_token
  } catch { return null }
}

// Prefere o token de vendedor; se não houver, usa o app token.
async function bearer() {
  const u = await getUserToken()
  return u || (await getAppToken())
}

export async function mlGet(pathname) {
  const token = await bearer()
  const r = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token}` } })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error('ml_error'), { status: r.status, data: d })
  return d
}

export function authStatus() {
  const u = readUserToken()
  return {
    ready: !!(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET),
    seller_connected: !!u,
    user_id: u?.user_id ?? null,
  }
}

// ===========================================================================
// Recursos
// ===========================================================================

export async function predictCategory(q) {
  if (!q) return []
  const r = await mlGet(`/sites/MLB/domain_discovery/search?limit=3&q=${encodeURIComponent(q)}`)
  return (Array.isArray(r) ? r : []).map((x) => ({
    category_id: x.category_id,
    category_name: x.category_name,
    domain_name: x.domain_name,
  }))
}

export async function getFees(q) {
  const price = Number(q.price)
  const listingType = q.listing_type || 'gold_special'
  const logisticType = q.logistic_type || 'cross_docking'
  const categoryId = (q.category_id || '').trim()
  const weightGrams = q.weight_grams ? Number(q.weight_grams) : 0

  function buildParams(withCat) {
    const p = new URLSearchParams({
      price: String(price), currency_id: 'BRL', listing_type_id: listingType,
      shipping_mode: 'me2', logistic_type: logisticType,
    })
    if (withCat && categoryId) p.set('category_id', categoryId)
    if (weightGrams) p.set('billable_weight', String(weightGrams))
    return p.toString()
  }

  let lpRes, categoriaUsada = categoryId || null
  try {
    lpRes = await mlGet(`/sites/MLB/listing_prices?${buildParams(true)}`)
  } catch (e) {
    if (e.status === 400 && categoryId) {
      lpRes = await mlGet(`/sites/MLB/listing_prices?${buildParams(false)}`)
      categoriaUsada = null
    } else throw e
  }

  const entry = Array.isArray(lpRes) ? lpRes.find((x) => x.listing_type_id === listingType) || lpRes[0] : lpRes
  const sale = entry?.sale_fee_details || {}
  const commissionTotal = entry?.sale_fee_amount ?? sale.gross_amount ?? 0
  const fixedFee = sale.fixed_fee ?? 0
  const percentageFee = sale.percentage_fee ?? null

  let freight = null
  if (weightGrams > 0) freight = estimarFrete(price, weightGrams / 1000, logisticType, q.free_shipping !== 'false')

  return {
    price, listing_type: listingType, logistic_type: logisticType, category_used: categoriaUsada,
    commission_total: commissionTotal, fixed_fee: fixedFee, percentage_fee: percentageFee,
    freight, freight_is_estimate: freight != null,
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { estimarFreteDetalhado, checarLimites, getModalidade } from './freight.js'

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

// ---------- Escrita na API (publicação) ----------
// Publicar/editar EXIGE o token de vendedor: o app token (client_credentials)
// não pode criar itens. Sem vendedor conectado, falha cedo com 401 pra a UI
// mostrar o convite de conexão em vez de um erro cru do ML.
export async function mlSend(method, pathname, body) {
  const token = await getUserToken()
  if (!token) throw Object.assign(new Error('vendedor_nao_conectado'), { status: 401 })
  const r = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // /items/validate responde 204 sem corpo quando está tudo certo.
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error('ml_error'), { status: r.status, data: d })
  return d
}
export const mlPost = (pathname, body) => mlSend('POST', pathname, body)

// Upload de uma foto: POST /pictures/items/upload (campo "file", multipart).
// O multipart é montado pelo fetch nativo do Node (FormData/Blob), então não
// precisamos de nenhuma dependência nem parser próprio. Retorna { id, variations }.
export async function mlUploadPicture(buffer, filename, mime) {
  const token = await getUserToken()
  if (!token) throw Object.assign(new Error('vendedor_nao_conectado'), { status: 401 })
  const fd = new FormData()
  fd.append('file', new Blob([buffer], { type: mime || 'image/jpeg' }), filename || 'foto.jpg')
  const r = await fetch(`${API}/pictures/items/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  })
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

// Preço atual do concorrente para um produto de catálogo já conhecido.
// Usa o CATALOG_ID vindo da análise e lê /products/{id}/items (a lista real de
// vendedores), pegando o MENOR preço ativo — igual ao que a análise fez.
export async function getCatalogLive(catalogId) {
  const r = await mlGet(`/products/${catalogId}/items`)
  const results = Array.isArray(r?.results) ? r.results : []
  let best = null
  for (const it of results) {
    if (it?.price == null) continue
    if (!best || it.price < best.price) best = it
  }
  return {
    catalog_id: catalogId,
    price: best?.price ?? null,
    item_id: best?.item_id ?? null,
    category_id: best?.category_id ?? null,
    logistic_type: best?.shipping?.logistic_type ?? null,
    free_shipping: best?.shipping?.free_shipping ?? null,
    n_vend: results.length,
    status: results.length ? 'com_vendedor' : 'sem_vendedor',
  }
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

  const offerFree = q.free_shipping !== 'false'

  // medidas da caixa (formato "AxLxC,pesoG") — usadas pro peso volumétrico e
  // pra checar os limites físicos da modalidade escolhida
  let alturaCm = 0, larguraCm = 0, comprimentoCm = 0
  if (q.dimensions) {
    const dims = String(q.dimensions).split(',')[0]
    const [a, l, c] = dims.split('x').map((n) => Number(n) || 0)
    alturaCm = a; larguraCm = l; comprimentoCm = c
  }
  const pesoRealKg = weightGrams / 1000
  const modalidade = getModalidade(logisticType)

  // Custos próprios da modalidade, informados pelo usuário:
  //  - Full: armazenagem/operação por unidade
  //  - Flex: quanto o motoboy/transportadora cobra de fato
  const custoOperacaoFull = q.full_op_cost ? Number(q.full_op_cost) || 0 : 0
  const custoEntregaFlex = q.flex_delivery_cost != null && q.flex_delivery_cost !== ''
    ? Number(q.flex_delivery_cost) || 0
    : null
  const descontoReputacao = q.reputation_discount ? Number(q.reputation_discount) : 0
  const elegivelSubsidio = q.eligible !== 'false'

  const opts = {
    alturaCm, larguraCm, comprimentoCm, descontoReputacao, elegivelSubsidio,
    custoOperacaoFull, custoEntregaFlex,
  }

  // Detalhamento por modalidade — vale pros dois caminhos (API e estimativa):
  // é dele que saem os limites de peso/medidas, o peso cobrável e a regra
  // financeira aplicada. Quando a API responde, só o VALOR do frete é trocado.
  const detalhe = estimarFreteDetalhado(price, pesoRealKg, logisticType, offerFree, opts)
  const limites = checarLimites(logisticType, pesoRealKg, { alturaCm, larguraCm, comprimentoCm })

  // 1) FRETE REAL da conta do vendedor (API oficial), quando conectado. Já vem
  //    com o desconto real da reputação e o peso volumétrico calculado pela ML.
  let freight = null, freightSource = 'estimate'
  const real = await getRealFreight({ price, listingType, logisticType, weightGrams, dimensions: q.dimensions })
  if (real) {
    freightSource = 'api'
    let base
    if (real.free_by_meli) base = 0                          // ML cobre 100% (faixa subsidiada)
    else if (price >= 79 || offerFree) base = real.list_cost // vendedor paga o custo real
    else base = 0                                            // abaixo de 79 e sem frete grátis: comprador paga

    if (modalidade.modelo === 'full') {
      // Acima de R$79 o ML cobre 50% do frete grátis no Full.
      if (!real.free_by_meli && price >= 79) base = base / 2
      base += detalhe.custo_extra                            // armazenagem/operação
    } else if (modalidade.modelo === 'flex') {
      // No Flex o custo real é o do SEU entregador; da API vem só a tarifa,
      // que serve de referência pro incentivo pago pelo ML.
      const tarifa = real.list_cost ?? detalhe.tarifa_base
      const entrega = custoEntregaFlex == null ? tarifa : custoEntregaFlex
      base = entrega - tarifa * detalhe.cobertura_ml_pct
    }
    freight = Math.round(base * 100) / 100
  } else if (weightGrams > 0) {
    // 2) FALLBACK: estimativa (peso volumétrico + desconto de reputação escolhido)
    freight = detalhe.custo_total
  }

  return {
    price, listing_type: listingType, logistic_type: logisticType, category_used: categoriaUsada,
    commission_total: commissionTotal, fixed_fee: fixedFee, percentage_fee: percentageFee,
    freight, freight_source: freightSource, freight_is_estimate: freightSource === 'estimate',
    freight_free_by_meli: real?.free_by_meli ?? null,
    billable_weight: real?.billable_weight ?? null,
    freight_detail: detalhe,
    freight_limits: limites,
  }
}

// Frete REAL que sai do bolso do vendedor, pela API oficial
// GET /users/{uid}/shipping_options/free — retorna o custo de oferecer frete
// grátis JÁ com os descontos reais da conta (reputação/loyalty) e o peso
// cobrável (maior entre real e volumétrico) calculado pela própria ML.
// Retorna null se não houver vendedor conectado ou se a chamada falhar (o
// getFees então cai na estimativa).
export async function getRealFreight({ price, listingType, logisticType, weightGrams, dimensions }) {
  const uid = authStatus().user_id
  if (!uid) return null
  if (!weightGrams && !dimensions) return null
  // a API exige dimensions "AxLxC,pesoG"; sem medidas, usa caixa mínima + peso
  const dim = dimensions && /^\d+x\d+x\d+,/.test(dimensions) ? dimensions : `1x1x1,${weightGrams || 0}`
  const qs = new URLSearchParams({
    dimensions: dim,
    item_price: String(price),
    listing_type_id: listingType,
    logistic_type: logisticType,
    condition: 'new',
    mode: 'me2',
    verbose: 'true',
  })
  try {
    const r = await mlGet(`/users/${uid}/shipping_options/free?${qs.toString()}`)
    const c = r?.coverage?.all_country
    if (!c || c.list_cost == null) return null
    return {
      list_cost: Number(c.list_cost),
      free_by_meli: !!c.free_shipping_by_meli,
      billable_weight: c.billable_weight ?? null,
      discount: c.discount ?? null,
    }
  } catch {
    return null
  }
}

// Termômetro de PROCURA: usa as VISITAS por dia (que o próprio ML guarda) dos
// anúncios do produto e compara a metade recente da janela com a metade
// anterior. Não precisa de banco — o histórico vem da API. Visita = interesse,
// não venda. Soma até 6 anúncios do produto para um sinal menos ruidoso.
export async function getTendenciaVisitas(itemIds, dias = 60) {
  const ids = (Array.isArray(itemIds) ? itemIds : String(itemIds || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
  if (!ids.length) return { encontrado: false }

  const respostas = await Promise.all(
    ids.map((id) => mlGet(`/items/${id}/visits/time_window?last=${dias}&unit=day`).catch(() => null))
  )
  const diaria = new Map() // 'YYYY-MM-DD' -> total de visitas somado entre anúncios
  let ok = 0
  for (const r of respostas) {
    if (!r) continue
    ok++
    for (const p of (r.results || [])) {
      if (p?.total == null || !p?.date) continue
      const dia = String(p.date).slice(0, 10)
      diaria.set(dia, (diaria.get(dia) || 0) + Number(p.total))
    }
  }
  if (!ok) return { encontrado: false }

  // metade recente x metade anterior da janela
  const corte = Date.now() - (dias / 2) * 24 * 3600 * 1000
  let recente = 0, antigo = 0
  for (const [dia, tot] of diaria) {
    const ts = new Date(dia + 'T00:00:00Z').getTime()
    if (ts >= corte) recente += tot
    else antigo += tot
  }
  const total = recente + antigo
  let direcao = 'estavel', change_pct = null
  if (antigo > 0) {
    change_pct = Math.round(((recente - antigo) / antigo) * 100)
    if (recente > antigo * 1.15) direcao = 'subindo'
    else if (recente < antigo * 0.85) direcao = 'caindo'
  } else if (recente > 0) {
    direcao = 'subindo' // sem base anterior: procura emergindo
  }
  return {
    encontrado: true,
    dias, meia_janela: Math.round(dias / 2),
    n_itens: ok, total, recente, antigo, change_pct, direcao,
    sinal_fraco: total < 15, // pouco tráfego => sinal ruidoso
  }
}

import { mlGet } from './ml.js'

// ===========================================================================
// Pesquisa de mercado de um produto no Mercado Livre.
// Usa o catálogo (funciona com o app token):
//   /products/search        -> acha o produto
//   /products/{id}          -> nome, link (permalink), foto
//   /products/{id}/items    -> TODOS os vendedores (preço, UF, frete, tipo)
//   /users/{seller_id}      -> reputação e total histórico de vendas do vendedor
//
// Limitação honesta da API pública: a quantidade vendida de CADA anúncio
// (sold_quantity) é bloqueada (403). Por isso "quem vende mais" é medido pelo
// total histórico de vendas do vendedor (tamanho da loja), não pelo anúncio.
// ===========================================================================

function limparNome(nome) {
  return String(nome)
    .replace(/\s+-\s+[^-]+$/, '') // remove " - MARCA" no fim
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const mediana = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// texto amigável da reputação
function reputacao(u) {
  const rep = u?.seller_reputation || {}
  const level = rep.level_id || null // "5_green" ... "1_red" ou null
  const power = rep.power_seller_status || null // platinum | gold | silver
  const total = rep.transactions?.total ?? null
  let selo = null
  if (power === 'platinum') selo = 'MercadoLíder Platinum'
  else if (power === 'gold') selo = 'MercadoLíder Gold'
  else if (power === 'silver') selo = 'MercadoLíder'
  return { level, power, selo, vendas_hist: total }
}

// cache simples de usuários dentro do processo (evita repetir /users)
const cacheUser = new Map()
async function getUser(id) {
  if (cacheUser.has(id)) return cacheUser.get(id)
  let u = null
  try { u = await mlGet(`/users/${id}`) } catch { u = null }
  cacheUser.set(id, u)
  return u
}

const UF_SIGLA = {
  Acre: 'AC', Alagoas: 'AL', Amapá: 'AP', Amazonas: 'AM', Bahia: 'BA',
  Ceará: 'CE', 'Distrito Federal': 'DF', 'Espírito Santo': 'ES', Goiás: 'GO',
  Maranhão: 'MA', 'Mato Grosso': 'MT', 'Mato Grosso do Sul': 'MS', 'Minas Gerais': 'MG',
  Pará: 'PA', Paraíba: 'PB', Paraná: 'PR', Pernambuco: 'PE', Piauí: 'PI',
  'Rio de Janeiro': 'RJ', 'Rio Grande do Norte': 'RN', 'Rio Grande do Sul': 'RS',
  Rondônia: 'RO', Roraima: 'RR', 'Santa Catarina': 'SC', 'São Paulo': 'SP',
  Sergipe: 'SE', Tocantins: 'TO',
}
const TIPO = { gold_pro: 'Premium', gold_special: 'Clássico' }

export async function pesquisarMercado(query) {
  const q = limparNome(query) || String(query || '')
  if (!q.trim()) return { matched: false, reason: 'sem_query' }

  // 1) acha o produto no catálogo
  const s = await mlGet(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}`)
  const results = Array.isArray(s?.results) ? s.results : []
  if (!results.length) return { matched: false, reason: 'sem_resultado', query: q }

  // 2+3) busca os vendedores dos primeiros candidatos EM PARALELO e usa o
  // primeiro (na ordem de relevância do ML) que tenha vendedores ativos.
  // O catálogo costuma trazer variações mortas ("No winners found") no topo.
  const candidatos = results.slice(0, 6)
  const comItens = await Promise.all(
    candidatos.map((c) =>
      mlGet(`/products/${c.id}/items`)
        .then((r) => ({ c, r }))
        .catch(() => ({ c, r: null }))
    )
  )
  const hit = comItens.find((x) => Array.isArray(x.r?.results) && x.r.results.length)
  if (!hit) {
    const c = results[0]
    return {
      matched: true, reason: 'sem_vendedor',
      product: { id: c.id, name: c.name, permalink: `https://www.mercadolivre.com.br/p/${c.id}` },
      n_vendedores: 0,
      outras_opcoes: results.slice(1, 6).map((r) => ({ id: r.id, name: r.name })),
    }
  }
  const prodBusca = hit.c
  const itensResp = hit.r
  const itens = itensResp.results
  const prod = await mlGet(`/products/${prodBusca.id}`).catch(() => null)

  // o vencedor da buy box (com app token não vem explícito): usamos o 1º da lista,
  // que é a ordem de relevância que o ML devolve (preço + reputação + frete).
  const winnerItem = itens[0]

  // 4) enriquece vendedores com reputação (dedup por seller_id, limita a 25)
  const usados = itens.slice(0, 25)
  const idsUnicos = [...new Set(usados.map((i) => i.seller_id))]
  const usersById = {}
  await Promise.all(
    idsUnicos.map(async (id) => { usersById[id] = await getUser(id) })
  )

  const anuncios = usados.map((it) => {
    const u = usersById[it.seller_id]
    const rep = reputacao(u)
    return {
      item_id: it.item_id,
      price: it.price,
      uf: UF_SIGLA[it.seller_address?.state?.name] || it.seller_address?.state?.name || '?',
      cidade: it.seller_address?.city?.name || null,
      tipo: TIPO[it.listing_type_id] || it.listing_type_id,
      free_shipping: !!it.shipping?.free_shipping,
      oficial: it.official_store_id != null,
      seller_id: it.seller_id,
      nickname: u?.nickname || `Vendedor ${it.seller_id}`,
      level: rep.level,
      selo: rep.selo,
      vendas_hist: rep.vendas_hist,
      winner: it.item_id === winnerItem.item_id,
    }
  })

  const precos = anuncios.map((a) => a.price).filter((p) => p != null)
  const winner = anuncios.find((a) => a.winner) || anuncios[0]

  // "quem vende mais" = maior total histórico de vendas entre os concorrentes
  const topVendedores = [...anuncios]
    .filter((a) => a.vendas_hist != null)
    .sort((a, b) => b.vendas_hist - a.vendas_hist)
    .slice(0, 5)

  // distribuições
  const porEstado = {}
  for (const a of anuncios) porEstado[a.uf] = (porEstado[a.uf] || 0) + 1

  return {
    matched: true,
    reason: 'ok',
    query: q,
    product: {
      id: prodBusca.id,
      name: prod?.name || prodBusca.name,
      permalink: prod?.permalink || `https://www.mercadolivre.com.br/p/${prodBusca.id}`,
      thumbnail: prodBusca?.pictures?.[0]?.url || prod?.pictures?.[0]?.url || null,
    },
    n_vendedores: itensResp?.paging?.total ?? anuncios.length,
    preco: {
      min: precos.length ? Math.min(...precos) : null,
      mediana: mediana(precos),
      max: precos.length ? Math.max(...precos) : null,
    },
    resumo: {
      oficiais: anuncios.filter((a) => a.oficial).length,
      frete_gratis: anuncios.filter((a) => a.free_shipping).length,
      premium: anuncios.filter((a) => a.tipo === 'Premium').length,
      por_estado: porEstado,
    },
    winner,
    top_vendedores: topVendedores,
    anuncios,
    outras_opcoes: results.slice(1, 5).map((r) => ({ id: r.id, name: r.name })),
  }
}

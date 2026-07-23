import { mlGet, getCatalogLive, predictCategory } from './ml.js'

// Limpa o nome do produto para melhorar o acerto na busca do catálogo:
// tira o sufixo " - MARCA", códigos soltos e espaços repetidos.
export function limparNome(nome) {
  return String(nome)
    .replace(/\s+-\s+[^-]+$/, '') // remove " - MARCA" no fim
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Resolve o nome "de verdade" de uma categoria (e a seção raiz) pela API do ML.
// Ex.: MLB12443 -> { name: 'Blocos e Formas de Montar',
//                    path: 'Brinquedos e Hobbies > ... > Blocos e Formas de Montar',
//                    root: 'Brinquedos e Hobbies' }
const _catCache = new Map()
async function categoryInfo(categoryId) {
  if (!categoryId) return null
  if (_catCache.has(categoryId)) return _catCache.get(categoryId)
  try {
    const c = await mlGet(`/categories/${categoryId}`)
    const path = Array.isArray(c?.path_from_root) ? c.path_from_root.map((p) => p.name) : []
    const info = { name: c?.name || null, path: path.join(' > '), root: path[0] || null }
    _catCache.set(categoryId, info)
    return info
  } catch {
    return null
  }
}

// Sugere ATÉ 3 categorias para o produto, sempre que possível, pra dar mais
// chance de acerto (o usuário escolhe). A ordem de confiança é:
//   1) categorias REAIS de produtos parecidos já anunciados no ML (o próprio ML
//      atribuiu — alta precisão);
//   2) palpites por palavra-chave do domain_discovery (reserva — pode errar com
//      nomes ambíguos, ex.: "BLOCO" de montar caindo em "Bloco de Motor").
// Cada sugestão vem com nome e caminho reais e a fonte ('produto' | 'palpite').
export async function suggestCategories(query) {
  const q = limparNome(query) || query
  if (!q) return []

  // 1) categorias reais dos primeiros produtos do catálogo (com vendedor ativo)
  let searchResults = []
  try {
    const r = await mlGet(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}`)
    searchResults = Array.isArray(r?.results) ? r.results.slice(0, 6) : []
  } catch {}
  const lives = await Promise.all(searchResults.map((c) => getCatalogLive(c.id).catch(() => null)))
  const peso = new Map() // category_id -> soma de vendedores (proxy de relevância)
  for (const live of lives) {
    if (!live?.category_id) continue
    peso.set(live.category_id, (peso.get(live.category_id) || 0) + (live.n_vend || 1))
  }
  const reais = [...peso.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)

  // 2) palpites por palavra-chave (reserva, pra completar até 3)
  let guesses = []
  try { guesses = await predictCategory(q) } catch {}

  // 3) monta a lista final deduplicada: reais primeiro, palpites depois
  const out = []
  const seen = new Set()
  for (const id of reais) {
    if (out.length >= 3 || seen.has(id)) continue
    const info = await categoryInfo(id)
    if (info) { out.push({ category_id: id, category_name: info.name, category_path: info.path, source: 'produto' }); seen.add(id) }
  }
  for (const g of guesses) {
    if (out.length >= 3) break
    if (!g.category_id || seen.has(g.category_id)) continue
    const info = await categoryInfo(g.category_id)
    out.push({
      category_id: g.category_id,
      category_name: info?.name || g.category_name,
      category_path: info?.path || '',
      source: 'palpite',
    })
    seen.add(g.category_id)
  }
  return out
}

// Busca um produto no catálogo pelo nome e devolve o MENOR preço praticado hoje
// (usa /products/{id}/items, que traz preço mesmo sem login de vendedor).
export async function findCompetitor(query) {
  const q = limparNome(query) || query
  const r = await mlGet(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}`)
  const results = Array.isArray(r?.results) ? r.results.slice(0, 3) : []
  if (!results.length) return { matched: false, reason: 'sem_resultado' }
  // tenta os primeiros resultados e pega o primeiro que tem preço ativo
  for (const cand of results) {
    try {
      const live = await getCatalogLive(cand.id)
      if (live.price != null) {
        const info = await categoryInfo(live.category_id)
        return {
          matched: true,
          reason: 'ok',
          catalog_id: cand.id,
          name: cand.name,
          price: live.price,
          item_id: live.item_id,
          category_id: live.category_id,
          category_name: info?.name || null,
          category_path: info?.path || null,
          n_vend: live.n_vend,
          url: `https://www.mercadolivre.com.br/p/${cand.id}`,
        }
      }
    } catch {
      // esse produto deu erro no catálogo — tenta o próximo
    }
  }
  // achou o produto mas ninguém vendendo agora
  return {
    matched: false,
    reason: 'sem_preco',
    catalog_id: results[0].id,
    name: results[0].name,
    url: `https://www.mercadolivre.com.br/p/${results[0].id}`,
  }
}

// Monta a BASE de um anúncio para o painel de revisão (NÃO publica nada).
// Quando o produto existe no catálogo do ML, traz título, fotos e atributos
// prontos (é o que o ML preencheria sozinho ao anunciar em cima do catálogo).
// Também lista os atributos obrigatórios da categoria, pra mostrar o que falta.
export async function getAnuncioBase(catalogId, categoryId) {
  let catalog = null
  if (catalogId) {
    try {
      const p = await mlGet(`/products/${catalogId}`)
      catalog = {
        matched: true,
        id: catalogId,
        title: p?.name || null,
        pictures: (Array.isArray(p?.pictures) ? p.pictures : []).map((x) => x.url).filter(Boolean),
        attributes: (Array.isArray(p?.attributes) ? p.attributes : [])
          .filter((a) => a.value_name)
          .map((a) => ({ id: a.id, name: a.name || a.id, value: a.value_name })),
      }
    } catch {
      catalog = null
    }
  }
  let requiredAttrs = []
  if (categoryId) {
    try {
      const at = await mlGet(`/categories/${categoryId}/attributes`)
      requiredAttrs = (Array.isArray(at) ? at : [])
        .filter((a) => a.tags && (a.tags.required || a.tags.catalog_required))
        .map((a) => ({ id: a.id, name: a.name || a.id }))
    } catch {
      requiredAttrs = []
    }
  }
  return { catalog, required_attributes: requiredAttrs }
}

// Busca um produto no catálogo do ML pelo nome e devolve o "vencedor" (buy box):
// preço praticado, categoria e tipo de logística. É o preço que você teria que igualar.
export async function findWinner(query) {
  const q = limparNome(query) || query
  const r = await mlGet(
    `/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}`
  )
  const first = r?.results?.[0]
  if (!first) return { matched: false, reason: 'sem_resultado' }

  const prod = await mlGet(`/products/${first.id}`)
  const w = prod?.buy_box_winner
  const range = prod?.buy_box_winner_price_range

  // preço: vencedor da buy box; se não houver, o menor do range de concorrentes
  let price = null
  let itemId = null
  let logisticType = null
  let freeShipping = null
  let categoryId = prod?.category_id || first?.category_id || null

  if (w && w.price != null) {
    price = w.price
    itemId = w.item_id
    categoryId = w.category_id || categoryId
    logisticType = w.shipping?.logistic_type || null
    freeShipping = w.shipping?.free_shipping ?? null
  } else if (range?.min?.price != null) {
    price = range.min.price
  }

  return {
    matched: price != null,
    reason: price != null ? 'ok' : 'catalogo_sem_preco', // achou no catálogo mas sem vendedor ativo
    catalog_id: first.id,
    name: first.name,
    domain_id: first.domain_id,
    item_id: itemId,
    category_id: categoryId,
    price,
    logistic_type: logisticType,
    free_shipping: freeShipping,
  }
}

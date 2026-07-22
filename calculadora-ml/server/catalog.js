import { mlGet, getCatalogLive } from './ml.js'

// Limpa o nome do produto para melhorar o acerto na busca do catálogo:
// tira o sufixo " - MARCA", códigos soltos e espaços repetidos.
function limparNome(nome) {
  return String(nome)
    .replace(/\s+-\s+[^-]+$/, '') // remove " - MARCA" no fim
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Resolve o nome "de verdade" de uma categoria (e a seção raiz) pela API do ML.
// Ex.: MLB12443 -> { name: 'Blocos e Formas de Montar',
//                    path: 'Brinquedos e Hobbies > ... > Blocos e Formas de Montar',
//                    root: 'Brinquedos e Hobbies' }
async function categoryInfo(categoryId) {
  if (!categoryId) return null
  try {
    const c = await mlGet(`/categories/${categoryId}`)
    const path = Array.isArray(c?.path_from_root) ? c.path_from_root.map((p) => p.name) : []
    return { name: c?.name || null, path: path.join(' > '), root: path[0] || null }
  } catch {
    return null
  }
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

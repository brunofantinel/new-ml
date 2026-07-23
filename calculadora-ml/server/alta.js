import { mlGet } from './ml.js'

// ===========================================================================
// O QUE ESTÁ EM ALTA NO MERCADO LIVRE (caminho inverso da calculadora).
// ===========================================================================
// Em vez de partir do seu produto, parte do que o ML já mostra como quente:
//
//   /highlights/MLB/category/{id}  -> ranking de MAIS VENDIDOS da categoria
//   /trends/MLB/{id}               -> termos mais buscados na categoria
//
// O ranking é venda de verdade (o ML monta), não visita. Vem em três tipos:
//   PRODUCT      -> produto do catálogo   ->  /products/{id}
//   USER_PRODUCT -> produto próprio de um vendedor -> /user-products/{id}
//   ITEM         -> anúncio solto -> /items/{id} responde 403 com token de
//                   aplicação, então mostramos só o link pro ML.
//
// Tudo com cache de 1 hora: o ranking não muda de minuto em minuto e assim a
// tela abre instantânea na segunda visita.

const TTL_MS = 60 * 60 * 1000
const cache = new Map()

function doCache(chave) {
  const c = cache.get(chave)
  if (c && Date.now() - c.t < TTL_MS) return c.dados
  return null
}
function guardar(chave, dados) {
  cache.set(chave, { t: Date.now(), dados })
  return dados
}

const attr = (lista, id) => (lista || []).find((a) => a.id === id)?.value_name || null

// --- categorias (para o seletor da tela) -----------------------------------
export async function categoriasRaiz() {
  const chave = 'raizes'
  const c = doCache(chave)
  if (c) return c
  const r = await mlGet('/sites/MLB/categories')
  return guardar(chave, (r || []).map((x) => ({ id: x.id, name: x.name })))
}

// Filhas de uma categoria. O ranking de categoria FOLHA é bem mais útil que o
// da raiz: na raiz o topo é sempre o campeão de venda do Brasil inteiro
// (chuveiro com 471 vendedores), que não dá pra brigar com conta nova.
export async function categoriasFilhas(id) {
  const chave = `filhas:${id}`
  const c = doCache(chave)
  if (c) return c
  const d = await mlGet(`/categories/${id}`)
  return guardar(chave, {
    id: d?.id || id,
    name: d?.name || null,
    path: (d?.path_from_root || []).map((p) => p.name).join(' > '),
    filhas: (d?.children_categories || []).map((x) => ({ id: x.id, name: x.name })),
  })
}

// --- resolve UMA posição do ranking ---------------------------------------
async function resolver(entrada) {
  const base = { id: entrada.id, posicao: entrada.position, tipo: entrada.type }

  if (entrada.type === 'PRODUCT') {
    const [p, itens] = await Promise.all([
      mlGet(`/products/${entrada.id}`).catch(() => null),
      mlGet(`/products/${entrada.id}/items`).catch(() => null),
    ])
    const res = Array.isArray(itens?.results) ? itens.results : []
    const precos = res.map((x) => x.price).filter((v) => v != null)
    return {
      ...base,
      nome: p?.name || null,
      marca: attr(p?.attributes, 'BRAND'),
      thumbnail: p?.pictures?.[0]?.url || null,
      preco_min: precos.length ? Math.min(...precos) : null,
      preco_max: precos.length ? Math.max(...precos) : null,
      n_vend: itens?.paging?.total ?? res.length,
      category_id: res[0]?.category_id || null,
      frete_gratis: res.some((x) => x.shipping?.free_shipping),
      oficiais: res.filter((x) => x.official_store_id != null).length,
      url: `https://www.mercadolivre.com.br/p/${entrada.id}`,
      catalogo: true,
    }
  }

  if (entrada.type === 'USER_PRODUCT') {
    const u = await mlGet(`/user-products/${entrada.id}`).catch(() => null)
    // quando o produto próprio aponta pro catálogo, aproveitamos o preço de lá
    let precos = [], nVend = null, categoryId = null
    if (u?.catalog_product_id) {
      const itens = await mlGet(`/products/${u.catalog_product_id}/items`).catch(() => null)
      const res = Array.isArray(itens?.results) ? itens.results : []
      precos = res.map((x) => x.price).filter((v) => v != null)
      nVend = itens?.paging?.total ?? res.length
      categoryId = res[0]?.category_id || null
    }
    return {
      ...base,
      nome: u?.name || u?.family_name || null,
      marca: attr(u?.attributes, 'BRAND'),
      thumbnail: u?.pictures?.[0]?.secure_url || u?.thumbnail || null,
      preco_min: precos.length ? Math.min(...precos) : null,
      preco_max: precos.length ? Math.max(...precos) : null,
      n_vend: nVend,
      category_id: categoryId,
      frete_gratis: null,
      oficiais: null,
      url: u?.catalog_product_id
        ? `https://www.mercadolivre.com.br/p/${u.catalog_product_id}`
        : `https://www.mercadolivre.com.br/${entrada.id}`,
      catalogo: !!u?.catalog_product_id,
    }
  }

  // ITEM: a API não abre os dados do anúncio pra token de aplicação.
  return {
    ...base,
    nome: null,
    marca: null,
    thumbnail: null,
    preco_min: null,
    n_vend: null,
    url: `https://produto.mercadolivre.com.br/${String(entrada.id).replace('MLB', 'MLB-')}`,
    catalogo: false,
    sem_dados: true,
  }
}

// --- o ranking completo de uma categoria ----------------------------------
export async function getEmAlta(categoryId) {
  const cat = String(categoryId || '').trim()
  if (!cat) return { erro: 'sem_categoria', itens: [] }

  const chave = `alta:${cat}`
  const c = doCache(chave)
  if (c) return c

  const [destaques, termos, info] = await Promise.all([
    mlGet(`/highlights/MLB/category/${cat}`).catch(() => null),
    mlGet(`/trends/MLB/${cat}`).catch(() => []),
    categoriasFilhas(cat).catch(() => null),
  ])

  const conteudo = Array.isArray(destaques?.content) ? destaques.content : []
  if (!conteudo.length) {
    return guardar(chave, {
      categoria: { id: cat, nome: info?.name || null, path: info?.path || null },
      tipo_ranking: destaques?.query_data?.highlight_type || null,
      termos: [],
      itens: [],
      vazio: true,
    })
  }

  // resolve em blocos pra não disparar 40 chamadas de uma vez
  const itens = []
  for (let i = 0; i < conteudo.length; i += 5) {
    const bloco = await Promise.all(conteudo.slice(i, i + 5).map((e) => resolver(e).catch(() => null)))
    itens.push(...bloco.filter(Boolean))
  }

  return guardar(chave, {
    categoria: { id: cat, nome: info?.name || null, path: info?.path || null },
    tipo_ranking: destaques?.query_data?.highlight_type || null,
    termos: (Array.isArray(termos) ? termos : []).slice(0, 12).map((t) => ({
      termo: t.keyword,
      url: t.url,
    })),
    itens,
  })
}

// Termos mais buscados do site inteiro (sem categoria) — usado como atalho
// na tela quando ainda não há categoria escolhida.
export async function termosDoSite() {
  const chave = 'trends:site'
  const c = doCache(chave)
  if (c) return c
  const r = await mlGet('/trends/MLB').catch(() => [])
  return guardar(chave, (Array.isArray(r) ? r : []).slice(0, 20).map((t) => ({ termo: t.keyword, url: t.url })))
}

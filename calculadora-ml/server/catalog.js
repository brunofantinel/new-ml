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

// ---------------------------------------------------------------------------
// Busca de CATEGORIA por nome (não por produto).
// ---------------------------------------------------------------------------
// suggestCategories() acima parte de um PRODUTO e deduz a categoria dele. Isso
// erra feio quando a pessoa digita um termo geral: "Blocos e Formas de Montar"
// cai em "Blocos de Motores" de autopeças, porque o texto casa com anúncios de
// peças. Aqui é o caminho contrário — procuramos na árvore de categorias do ML
// pelo NOME, que é o que a pessoa espera ao digitar "Eletrônicos".
//
// Carregamos os dois primeiros níveis (≈30 raízes + os filhos delas) uma única
// vez por processo; é o suficiente pra alguém escolher uma categoria geral, e
// evita baixar a árvore inteira, que tem milhares de nós.
let _arvoreCache = null
async function categoriasAteNivel2() {
  if (_arvoreCache) return _arvoreCache
  const raizes = await mlGet('/sites/MLB/categories')
  const lista = []
  for (const r of raizes) lista.push({ id: r.id, name: r.name, path: r.name })
  const detalhes = await Promise.all(
    raizes.map((r) => mlGet(`/categories/${r.id}`).catch(() => null))
  )
  detalhes.forEach((d, i) => {
    const raiz = raizes[i]
    for (const filho of d?.children_categories || []) {
      lista.push({ id: filho.id, name: filho.name, path: `${raiz.name} > ${filho.name}` })
    }
  })
  _arvoreCache = lista
  return lista
}

// "Eletrônicos" e "eletronicos" têm que casar.
const semAcento = (s) =>
  String(s || '')
    .normalize('NFD')
    // tira os diacriticos (faixa combining U+0300-U+036F) sem depender de
    // caracteres literais no fonte, que quebram se o arquivo mudar de encoding
    .split('')
    .filter((ch) => { const c = ch.charCodeAt(0); return c < 0x0300 || c > 0x036f })
    .join('')
    .toLowerCase()

export async function buscarCategorias(query) {
  const q = semAcento(query).trim()
  if (!q) return []
  const todas = await categoriasAteNivel2()
  const termos = q.split(/\s+/).filter(Boolean)

  // pontua por quão forte é o casamento no NOME da categoria; o caminho conta
  // pouco, só pra desempatar
  const pontuar = (c) => {
    const nome = semAcento(c.name)
    const caminho = semAcento(c.path)
    let p = 0
    for (const t of termos) {
      if (nome === t) p += 100
      else if (nome.startsWith(t)) p += 50
      else if (nome.includes(t)) p += 30
      else if (caminho.includes(t)) p += 10
    }
    return p
  }

  return todas
    .map((c) => ({ c, p: pontuar(c) }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p || a.c.path.length - b.c.path.length)
    .slice(0, 8)
    .map(({ c }) => ({
      category_id: c.id,
      category_name: c.name,
      category_path: c.path,
      source: 'categoria',
    }))
}

// Busca um produto no catálogo pelo nome e devolve o MENOR preço praticado hoje
// (usa /products/{id}/items, que traz preço mesmo sem login de vendedor).
export async function findCompetitor(query) {
  const q = limparNome(query) || query
  const r = await mlGet(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}`)
  const results = Array.isArray(r?.results) ? r.results.slice(0, 5) : []
  if (!results.length) return { matched: false, reason: 'sem_resultado', candidatos: [] }

  // monta ATÉ 3 candidatos com preço, pra o usuário confirmar qual é o produto
  const candidatos = []
  for (const cand of results) {
    if (candidatos.length >= 3) break
    try {
      const live = await getCatalogLive(cand.id)
      if (live.price == null) continue
      const info = await categoryInfo(live.category_id)
      candidatos.push({
        catalog_id: cand.id,
        name: cand.name,
        thumbnail: cand.pictures?.[0]?.url || null,
        price: live.price,
        item_id: live.item_id,
        category_id: live.category_id,
        category_name: info?.name || null,
        category_path: info?.path || null,
        n_vend: live.n_vend,
        url: `https://www.mercadolivre.com.br/p/${cand.id}`,
      })
    } catch {
      // esse produto deu erro no catálogo — tenta o próximo
    }
  }

  if (!candidatos.length) {
    // achou produto(s) mas ninguém vendendo agora
    return {
      matched: false,
      reason: 'sem_preco',
      candidatos: [],
      catalog_id: results[0].id,
      name: results[0].name,
      url: `https://www.mercadolivre.com.br/p/${results[0].id}`,
    }
  }

  // o primeiro é o padrão (compat com o resto do app); todos vão em `candidatos`
  return { matched: true, reason: 'ok', ...candidatos[0], candidatos }
}

// ---------------------------------------------------------------------------
// PESO E MEDIDAS DA EMBALAGEM a partir do anúncio no ML.
// ---------------------------------------------------------------------------
// Quem já vende o produto precisou declarar o pacote pro ML calcular o frete.
// Esses números ficam nos atributos PACKAGE_* do anúncio (e às vezes em
// shipping.dimensions, no formato "AxLxC,pesoG"). Servem de ponto de partida
// pro passo 3 — a pessoa confere e edita se a embalagem dela for outra.

// Conversões: o ML devolve a unidade junto do número, e ela varia por anúncio.
const PARA_KG = { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, oz: 0.0283495 }
const PARA_CM = { cm: 1, mm: 0.1, m: 100, in: 2.54, '"': 2.54, ft: 30.48 }

const arredondar = (n, casas) => Math.round(n * 10 ** casas) / 10 ** casas

// Lê o primeiro atributo da lista `ids` e converte pra kg/cm. Devolve null se
// não achar, se o número não fizer sentido ou se a unidade for desconhecida
// (melhor ficar sem o dado do que chutar uma unidade errada).
//
// O ML devolve o valor em três formatos diferentes conforme o endpoint:
//   value_struct: {number, unit}          -> /products/{id}
//   value_name: "500 g"                   -> /products/{id}
//   values: [{struct: {number, unit}}]    -> /user-products/{id}
// O terceiro é o do anúncio do vendedor, que é justamente o que interessa.
function medidaAttr(attrs, ids, tabela, casas) {
  for (const id of ids) {
    const a = attrs.find((x) => x?.id === id)
    if (!a) continue
    const v0 = Array.isArray(a.values) ? a.values[0] : null
    const struct = a.value_struct || v0?.struct || null
    const nome = a.value_name || v0?.name || null

    let numero = null
    let unidade = null
    if (struct && struct.number != null) {
      numero = Number(struct.number)
      unidade = struct.unit
    } else if (nome) {
      const m = String(nome).match(/^\s*([\d.,]+)\s*([^\s\d]+)?/)
      if (m) {
        numero = Number(m[1].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'))
        unidade = m[2]
      }
    }
    if (!Number.isFinite(numero) || numero <= 0) continue
    const fator = tabela[String(unidade || '').trim().toLowerCase()]
    if (!fator) continue
    return arredondar(numero * fator, casas)
  }
  return null
}

// Medidas da EMBALAGEM (é o que interessa pro frete). O SELLER_PACKAGE_* vem
// primeiro de propósito: é a caixa que aquele vendedor realmente despacha, que
// o ML usa pra cobrar o frete dele. O PACKAGE_* é o do catálogo, mais genérico.
function pacoteDosAtributos(attrs) {
  const A = Array.isArray(attrs) ? attrs : []
  return {
    peso_kg: medidaAttr(A, ['SELLER_PACKAGE_WEIGHT', 'PACKAGE_WEIGHT', 'SHIPPING_WEIGHT'], PARA_KG, 3),
    altura_cm: medidaAttr(A, ['SELLER_PACKAGE_HEIGHT', 'PACKAGE_HEIGHT'], PARA_CM, 1),
    largura_cm: medidaAttr(A, ['SELLER_PACKAGE_WIDTH', 'PACKAGE_WIDTH'], PARA_CM, 1),
    comprimento_cm: medidaAttr(A, ['SELLER_PACKAGE_LENGTH', 'PACKAGE_LENGTH'], PARA_CM, 1),
  }
}

// Medidas do PRODUTO em si (sem caixa) — reserva, quando ninguém declarou o
// pacote. Vai marcada como fonte 'produto' pra tela avisar que falta a embalagem.
function produtoDosAtributos(attrs) {
  const A = Array.isArray(attrs) ? attrs : []
  return {
    peso_kg: medidaAttr(A, ['WEIGHT', 'NET_WEIGHT', 'UNIT_WEIGHT'], PARA_KG, 3),
    altura_cm: medidaAttr(A, ['HEIGHT'], PARA_CM, 1),
    largura_cm: medidaAttr(A, ['WIDTH'], PARA_CM, 1),
    comprimento_cm: medidaAttr(A, ['LENGTH', 'DEPTH'], PARA_CM, 1),
  }
}

const temTudo = (s) => !!(s && s.peso_kg && s.altura_cm && s.largura_cm && s.comprimento_cm)

// Junta dois conjuntos preenchendo só os buracos do primeiro.
function completar(base, extra) {
  if (!extra) return base
  const out = { ...base }
  for (const k of ['peso_kg', 'altura_cm', 'largura_cm', 'comprimento_cm']) {
    if (out[k] == null && extra[k] != null) out[k] = extra[k]
  }
  return out
}

// Devolve { encontrado, peso_kg, altura_cm, largura_cm, comprimento_cm, fonte }.
// fonte: 'anuncio' = embalagem declarada por quem vende | 'produto' = medidas do
// produto no catálogo (sem a caixa).
export async function getPacoteAnuncio(catalogId, itemId) {
  // 1) O pacote declarado por quem vende.
  //    /items/{id} responde 403 pra token de aplicação (o ML fechou a leitura
  //    de anúncio de terceiro), mas /products/{id}/items devolve o
  //    `user_product_id` de cada anúncio, e /user-products/{id} abre normal —
  //    é lá que ficam os SELLER_PACKAGE_* com a caixa real do vendedor.
  let upids = []
  if (catalogId) {
    try {
      const r = await mlGet(`/products/${catalogId}/items`)
      const res = Array.isArray(r?.results) ? r.results : []
      // o anúncio que o app já escolheu (o mais barato) vai na frente
      const ordenados = itemId
        ? [...res].sort((a, b) => (b.item_id === itemId ? 1 : 0) - (a.item_id === itemId ? 1 : 0))
        : res
      upids = [...new Set(ordenados.map((x) => x.user_product_id).filter(Boolean))].slice(0, 4)
    } catch {}
  }
  const anuncios = await Promise.all(
    upids.map((id) => mlGet(`/user-products/${id}`).catch(() => null))
  )

  const candidatos = []
  for (const u of anuncios) {
    if (!u) continue
    candidatos.push({ ...pacoteDosAtributos(u.attributes), fonte: 'anuncio' })
  }

  // 2) reserva: o próprio produto do catálogo
  let doCatalogo = null
  if (catalogId) {
    const p = await mlGet(`/products/${catalogId}`).catch(() => null)
    if (p) {
      candidatos.push({ ...pacoteDosAtributos(p.attributes), fonte: 'anuncio' })
      doCatalogo = { ...produtoDosAtributos(p.attributes), fonte: 'produto' }
    }
  }

  // Preferimos um conjunto COMPLETO de um único anúncio (não misturar a caixa
  // de um vendedor com a de outro). Só se ninguém tiver tudo é que juntamos.
  let escolhido =
    candidatos.find(temTudo) ||
    (temTudo(doCatalogo) ? doCatalogo : null)

  if (!escolhido) {
    const juntos = candidatos.reduce((acc, c) => completar(acc, c), {
      peso_kg: null, altura_cm: null, largura_cm: null, comprimento_cm: null,
    })
    if (juntos.peso_kg || juntos.altura_cm) escolhido = { ...juntos, fonte: 'anuncio' }
    else if (doCatalogo && (doCatalogo.peso_kg || doCatalogo.altura_cm)) escolhido = doCatalogo
  }

  if (!escolhido) return { encontrado: false, catalog_id: catalogId || null }
  return {
    encontrado: true,
    catalog_id: catalogId || null,
    peso_kg: escolhido.peso_kg ?? null,
    altura_cm: escolhido.altura_cm ?? null,
    largura_cm: escolhido.largura_cm ?? null,
    comprimento_cm: escolhido.comprimento_cm ?? null,
    completo: temTudo(escolhido),
    fonte: escolhido.fonte,
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

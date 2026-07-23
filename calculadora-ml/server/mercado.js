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

// ---------------------------------------------------------------------------
// CASAMENTO PRODUTO ERP -> CATÁLOGO DO ML
// ---------------------------------------------------------------------------
// A busca do catálogo (/products/search) NÃO faz lookup exato por código de
// barras: ela trata o EAN como palavra-chave e devolve qualquer variante
// "parecida" (testado: EAN 7891023547183 -> voltou a variante ERRADA, sem nem
// atributo GTIN). Por isso:
//   - GTIN só vale se algum candidato tiver o ATRIBUTO GTIN idêntico ao EAN.
//   - o sinal confiável é o NOME: pontuamos cada candidato pela semelhança com
//     a descrição da ERP e escolhemos o MAIS PARECIDO (não o 1º com vendedor).
// Assim paramos de casar com a variante errada e de "não achar" por escolher
// um candidato morto.

const LIMIAR_NOME = 0.4 // semelhança mínima (0..1) p/ aceitar um match por nome

const STOP = new Set(['de', 'da', 'do', 'para', 'com', 'em', 'no', 'na'])

const normaliza = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')

function tokens(s) {
  return normaliza(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 2 && !STOP.has(w))
}

// semelhança 0..1 entre o nome do candidato e os tokens da descrição da ERP.
// token igual conta 1; token com o mesmo prefixo de 4 letras conta 0,6 (pra
// pegar variação de gênero: "branca" ~ "branco", "vermelha" ~ "vermelho").
function scoreNome(candidato, alvoTokens) {
  if (!alvoTokens.length) return 0
  const cand = tokens(candidato)
  const set = new Set(cand)
  const pref = new Set(cand.map((w) => w.slice(0, 4)))
  let s = 0
  for (const t of alvoTokens) {
    if (set.has(t)) s += 1
    else if (t.length >= 4 && pref.has(t.slice(0, 4))) s += 0.6
  }
  return s / alvoTokens.length
}

function gtinDoProduto(d) {
  const a = (d?.attributes || []).find((x) => x?.id === 'GTIN' || x?.id === 'EAN')
  const v = a?.value_name ?? (Array.isArray(a?.values) ? a.values[0]?.name : null)
  return v ? String(v).replace(/\D/g, '') : null
}

// variações de busca por nome: nome inteiro; se não achar, encurta (5 e 3
// primeiros termos). A precisão não cai porque a pontuação usa o nome COMPLETO.
function variantesNome(base) {
  const t = tokens(base)
  const v = [base]
  if (t.length > 5) v.push(t.slice(0, 5).join(' '))
  if (t.length > 3) v.push(t.slice(0, 3).join(' '))
  return [...new Set(v.filter((x) => x && x.trim()))]
}

// Acha os anúncios de UM produto específico tentando os identificadores em
// ordem de precisão: código de barras (GTIN) -> código de barras da NF ->
// referência -> descrição. A pontuação por nome usa SEMPRE a descrição da ERP.
export async function buscarAnuncios({ gtin, gtin_nf, ref, nome } = {}) {
  const tentativas = [
    gtin && { via: 'codigo_barras', q: String(gtin), gtinExato: String(gtin) },
    gtin_nf && { via: 'codigo_barras_nf', q: String(gtin_nf), gtinExato: String(gtin_nf) },
    ref && { via: 'referencia', q: String(ref) },
    nome && { via: 'descricao', q: String(nome) },
  ].filter(Boolean)

  if (!tentativas.length) return { matched: false, reason: 'sem_identificador' }

  let ultimo = null
  for (const t of tentativas) {
    const r = await pesquisarMercado(t.q, { gtinExato: t.gtinExato, nomeAlvo: nome || t.q }).catch(() => null)
    if (!r) continue
    ultimo = { ...r, via: t.via, termo: t.q }
    if (r.matched && (r.n_vendedores || 0) > 0) return ultimo
  }
  // nenhum com vendedor ativo — devolve o último que ao menos achou o produto
  return ultimo || { matched: false, reason: 'sem_resultado' }
}

export async function pesquisarMercado(query, opts = {}) {
  const { gtinExato = null, nomeAlvo = '' } = opts
  const alvo = tokens(nomeAlvo || query)

  // 1) monta as variantes de busca e pega o 1º conjunto de resultados
  const variantes = gtinExato
    ? [String(query).replace(/\D/g, '')]
    : variantesNome(limparNome(query) || String(query || ''))
  let results = []
  let usada = ''
  for (const v of variantes) {
    if (!v.trim()) continue
    const s = await mlGet(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(v)}`).catch(() => null)
    const rs = Array.isArray(s?.results) ? s.results : []
    if (rs.length) { results = rs; usada = v; break }
  }
  if (!results.length) return { matched: false, reason: 'sem_resultado', query: usada || query }

  // 2) vendedores dos candidatos em paralelo (+ detalhes só se for conferir GTIN)
  const candidatos = results.slice(0, 8)
  const comItens = await Promise.all(
    candidatos.map((c) =>
      mlGet(`/products/${c.id}/items`).then((r) => ({ c, r })).catch(() => ({ c, r: null }))
    )
  )
  let det = {}
  if (gtinExato) {
    const ds = await Promise.all(
      candidatos.map((c) => mlGet(`/products/${c.id}`).then((d) => [c.id, d]).catch(() => [c.id, null]))
    )
    det = Object.fromEntries(ds)
  }
  const gAlvo = gtinExato ? String(gtinExato).replace(/\D/g, '') : null

  // 3) pontua cada candidato (nome) e marca quem tem vendedor / GTIN exato
  const scored = comItens.map(({ c, r }) => ({
    c,
    r,
    temVend: Array.isArray(r?.results) && r.results.length > 0,
    sc: scoreNome(c.name, alvo),
    gExato: !!gAlvo && gtinDoProduto(det[c.id]) === gAlvo,
  }))

  // 4) escolhe.
  // Busca por código de barras: SÓ vale match de GTIN exato — o catálogo devolve
  // variante errada pro EAN como palavra-chave, então NÃO aceitamos por nome
  // aqui; sem exato, a próxima tentativa (referência/descrição) é que decide.
  if (gAlvo) {
    const esc = scored.find((x) => x.gExato && x.temVend) || scored.find((x) => x.gExato)
    if (!esc) return { matched: false, reason: 'gtin_sem_exato', query: usada }
    if (!esc.temVend) return semVendedor(esc.c, results, usada)
    return montarResultado(esc.c, esc.r, results, usada)
  }

  // Busca por nome/referência: o candidato MAIS PARECIDO com a descrição da ERP
  // (acima do limiar) com vendedor; senão o mais parecido sem vendedor (produto
  // existe, ninguém vendendo). Abaixo do limiar consideramos que não achou.
  const esc = scored.filter((x) => x.temVend && x.sc >= LIMIAR_NOME).sort((a, b) => b.sc - a.sc)[0]
  if (!esc) {
    const geral = scored.filter((x) => x.sc >= LIMIAR_NOME).sort((a, b) => b.sc - a.sc)[0]
    if (geral) return semVendedor(geral.c, results, usada)
    return { matched: false, reason: 'sem_match_confiavel', query: usada }
  }
  return montarResultado(esc.c, esc.r, results, usada)
}

// produto achado no catálogo, mas sem nenhum vendedor ativo no momento
function semVendedor(c, results, query) {
  return {
    matched: true,
    reason: 'sem_vendedor',
    query,
    product: {
      id: c.id,
      name: c.name,
      permalink: `https://www.mercadolivre.com.br/p/${c.id}`,
      thumbnail: c?.pictures?.[0]?.url || null,
    },
    n_vendedores: 0,
    outras_opcoes: results.filter((r) => r.id !== c.id).slice(0, 5).map((r) => ({ id: r.id, name: r.name })),
  }
}

// monta a resposta completa (preço, vendedores, reputação) do produto escolhido
async function montarResultado(prodBusca, itensResp, results, query) {
  const itens = itensResp.results
  const prod = await mlGet(`/products/${prodBusca.id}`).catch(() => null)

  // o vencedor da buy box (com app token não vem explícito): usamos o 1º da lista,
  // que é a ordem de relevância que o ML devolve (preço + reputação + frete).
  const winnerItem = itens[0]

  // enriquece vendedores com reputação (dedup por seller_id, limita a 25)
  const usados = itens.slice(0, 25)
  const idsUnicos = [...new Set(usados.map((i) => i.seller_id))]
  const usersById = {}
  await Promise.all(idsUnicos.map(async (id) => { usersById[id] = await getUser(id) }))

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
      permalink: it.permalink || `https://www.mercadolivre.com.br/p/${prodBusca.id}`,
    }
  })

  const precos = anuncios.map((a) => a.price).filter((p) => p != null)
  const winner = anuncios.find((a) => a.winner) || anuncios[0]

  const topVendedores = [...anuncios]
    .filter((a) => a.vendas_hist != null)
    .sort((a, b) => b.vendas_hist - a.vendas_hist)
    .slice(0, 5)

  const porEstado = {}
  for (const a of anuncios) porEstado[a.uf] = (porEstado[a.uf] || 0) + 1

  return {
    matched: true,
    reason: 'ok',
    query,
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
    outras_opcoes: results.filter((r) => r.id !== prodBusca.id).slice(0, 5).map((r) => ({ id: r.id, name: r.name })),
  }
}

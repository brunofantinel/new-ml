import fs from 'node:fs'
import path from 'node:path'
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

// O valor de um atributo vem em `value_name` no /products e em `values[0].name`
// no /user-products — os dois formatos aparecem aqui.
const attr = (lista, id) => {
  const a = (lista || []).find((x) => x?.id === id)
  if (!a) return null
  return a.value_name || (Array.isArray(a.values) ? a.values[0]?.name : null) || null
}

// A API do ML devolve 503/429 esporadico quando varios cards sao resolvidos ao
// mesmo tempo. Sem retentativa um card perdia o nome ou o preco por causa de
// uma falha passageira, entao insistimos com espera crescente. 403 e 404 sao
// definitivos: nao adianta repetir.
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
export async function api(rota, tentativas = 4) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await mlGet(rota)
    } catch (e) {
      const s = e.status || 0
      if (s === 403 || s === 404 || i === tentativas - 1) throw e
      await dormir(500 * 2 ** i) // 0,5s · 1s · 2s
    }
  }
}

// ---------------------------------------------------------------------------
// Quanto vende e se está crescendo.
// ---------------------------------------------------------------------------
// A API pública NÃO abre a quantidade vendida por anúncio (sold_quantity dá
// 403). Os dois melhores substitutos que sobram:
//
//   AVALIAÇÕES (/reviews/item/{id}) — só quem comprou avalia, então o total é
//   um piso de quantas vendas o produto já teve na vida. Não dá pra saber
//   QUANDO cada uma veio: elas voltam ordenadas por relevância e o
//   sort=date_desc é ignorado; paginar 30 mil avaliações não é viável.
//
//   VISITAS (/items/{id}/visits/time_window) — essas sim vêm com data, dia a
//   dia. Comparando a metade recente da janela com a anterior dá pra dizer se
//   a procura vem subindo ou caindo AGORA.
//
// Um mede o acumulado, o outro o movimento. Juntos respondem "vende bem?" e
// "está esquentando ou esfriando?".

// Janelas que a tela oferece. Quanto maior, mais estável o sinal — mas mais
// devagar ele reage a uma mudança recente.
const JANELAS = [30, 60, 90]
const JANELA_PADRAO = 30
const validarJanela = (d) => (JANELAS.includes(Number(d)) ? Number(d) : JANELA_PADRAO)

export async function avaliacoes(itemId) {
  if (!itemId) return null
  try {
    const r = await api(`/reviews/item/${itemId}?limit=1`)
    const total = r?.paging?.total ?? null
    if (total == null) return null
    return { total, nota: r?.rating_average ?? null }
  } catch {
    return null
  }
}

// Visitas somadas de até 3 anúncios do mesmo produto (sinal menos ruidoso),
// com a comparação entre as duas metades da janela.
export async function demanda(itemIds, dias = JANELA_PADRAO) {
  const ids = (itemIds || []).filter(Boolean).slice(0, 3)
  if (!ids.length) return null
  const corte = Date.now() - (dias / 2) * 24 * 3600 * 1000
  let total = 0, recente = 0, antigo = 0, ok = 0
  // dia (YYYY-MM-DD) -> visitas somadas dos anúncios daquele produto
  const porDia = new Map()

  await Promise.all(ids.map(async (id) => {
    try {
      const v = await api(`/items/${id}/visits/time_window?last=${dias}&unit=day`)
      ok++
      for (const p of v?.results || []) {
        const n = Number(p?.total) || 0
        if (!n) continue
        total += n
        const dia = String(p.date).slice(0, 10)
        porDia.set(dia, (porDia.get(dia) || 0) + n)
        const ts = new Date(dia + 'T00:00:00Z').getTime()
        if (ts >= corte) recente += n
        else antigo += n
      }
    } catch { /* anúncio sem visita pública */ }
  }))
  if (!ok) return null

  // Com pouca visita o percentual vira ruído (1 -> 4 já é "+300%"), então a
  // tendência só é afirmada quando há tráfego que sustente.
  let direcao = 'sem sinal'
  let variacao = null
  if (total < 15) direcao = 'pouco movimento'
  else {
    if (antigo > 0) variacao = Math.round(((recente - antigo) / antigo) * 100)
    if (recente > antigo * 1.15) direcao = 'subindo'
    else if (recente < antigo * 0.85) direcao = 'caindo'
    else direcao = 'estavel'
  }
  // SÉRIE DIÁRIA para o gráfico. Dois cuidados que o endpoint do ML exige:
  //  1) ele OMITE os dias sem nenhuma visita — se a gente não preencher com
  //     zero, o gráfico "pula" o dia e a linha mente;
  //  2) os pontos NÃO vêm em ordem cronológica — a ordem do array é arbitrária.
  // Por isso montamos a série a partir do calendário, não da resposta.
  // A janela do ML é INCLUSIVA nas duas pontas: `last=30` cobre de hoje-30 até
  // hoje. HOJE fica de fora do gráfico de propósito: é um dia em andamento, com
  // só algumas horas contabilizadas, e desenhado ele vira um mergulho pra perto
  // do zero na ponta da linha todo santo dia. Os totais e a tendência acima
  // continuam contando com ele.
  const serie = []
  const hojeUtc = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  for (let i = dias; i >= 1; i--) {
    const dia = new Date(hojeUtc - i * 86400000).toISOString().slice(0, 10)
    serie.push(porDia.get(dia) || 0)
  }
  const serieInicio = new Date(hojeUtc - dias * 86400000).toISOString().slice(0, 10)

  return {
    visitas: total,
    visitas_dia: Math.round((total / dias) * 10) / 10,
    recente, antigo, direcao, variacao, dias,
    serie,                 // uma posição por dia, do mais antigo pro mais novo
    serie_inicio: serieInicio,
    dias_sem_visita: serie.filter((n) => n === 0).length,
  }
}

// ---------------------------------------------------------------------------
// Histórico de posição no ranking.
// ---------------------------------------------------------------------------
// O ML não publica histórico nenhum: /highlights é sempre uma foto de agora.
// Então guardamos a nossa própria foto a cada consulta e comparamos com a do
// dia anterior. O histórico começa no dia em que você abre a tela pela
// primeira vez — antes disso não há como saber quem subiu.
const DIR_DADOS = path.resolve(process.cwd(), 'dados')
const ARQ_HIST = path.join(DIR_DADOS, 'historico-alta.json')
const MAX_DIAS_GUARDADOS = 30

function lerHistorico() {
  try { return JSON.parse(fs.readFileSync(ARQ_HIST, 'utf8')) } catch { return {} }
}
function gravarHistorico(h) {
  try {
    fs.mkdirSync(DIR_DADOS, { recursive: true })
    fs.writeFileSync(ARQ_HIST, JSON.stringify(h))
  } catch { /* disco somente leitura: segue sem histórico */ }
}
const hoje = () => new Date().toISOString().slice(0, 10)

// Grava a posição de cada item hoje e devolve o movimento desde a última foto.
function registrarEComparar(categoryId, itens) {
  const h = lerHistorico()
  const daCategoria = h[categoryId] || {}
  const dia = hoje()

  // dia anterior mais recente que já tenha foto
  const anteriores = Object.keys(daCategoria).filter((d) => d < dia).sort()
  const ultimo = anteriores[anteriores.length - 1] || null
  const antes = ultimo ? daCategoria[ultimo] : null

  const movimento = {}
  for (const it of itens) {
    if (!antes) continue
    const posAntes = antes[it.id]
    if (posAntes == null) movimento[it.id] = { novo: true, desde: ultimo }
    else movimento[it.id] = { delta: posAntes - it.posicao, antes: posAntes, desde: ultimo }
  }

  // grava a foto de hoje (sobrescreve se já houver uma de hoje)
  daCategoria[dia] = Object.fromEntries(itens.map((it) => [it.id, it.posicao]))
  const dias = Object.keys(daCategoria).sort()
  while (dias.length > MAX_DIAS_GUARDADOS) delete daCategoria[dias.shift()]
  h[categoryId] = daCategoria
  gravarHistorico(h)

  return { movimento, comparado_com: ultimo, dias_guardados: Object.keys(daCategoria).length }
}

// --- categorias (para o seletor da tela) -----------------------------------
export async function categoriasRaiz() {
  const chave = 'raizes'
  const c = doCache(chave)
  if (c) return c
  const r = await api('/sites/MLB/categories')
  return guardar(chave, (r || []).map((x) => ({ id: x.id, name: x.name })))
}

// Filhas de uma categoria. O ranking de categoria FOLHA é bem mais útil que o
// da raiz: na raiz o topo é sempre o campeão de venda do Brasil inteiro
// (chuveiro com 471 vendedores), que não dá pra brigar com conta nova.
export async function categoriasFilhas(id) {
  const chave = `filhas:${id}`
  const c = doCache(chave)
  if (c) return c
  const d = await api(`/categories/${id}`)
  return guardar(chave, {
    id: d?.id || id,
    name: d?.name || null,
    path: (d?.path_from_root || []).map((p) => p.name).join(' > '),
    filhas: (d?.children_categories || []).map((x) => ({ id: x.id, name: x.name })),
  })
}

// --- resolve UMA posição do ranking ---------------------------------------
async function resolver(entrada, dias) {
  const base = { id: entrada.id, posicao: entrada.position, tipo: entrada.type }

  if (entrada.type === 'PRODUCT') {
    const [p, itens] = await Promise.all([
      api(`/products/${entrada.id}`).catch(() => null),
      api(`/products/${entrada.id}/items`).catch(() => null),
    ])
    const res = Array.isArray(itens?.results) ? itens.results : []
    const precos = res.map((x) => x.price).filter((v) => v != null)
    const itemIds = res.map((x) => x.item_id).filter(Boolean)
    // /products/{id} é o endpoint mais instável do ML (503 até isolado em
    // alguns ids). Quando ele não vem, o produto próprio do primeiro vendedor
    // tem o mesmo nome e foto — melhor isso que um card "Sem nome".
    let reserva = null
    if (!p?.name) {
      const upid = res.find((x) => x.user_product_id)?.user_product_id
      if (upid) reserva = await api(`/user-products/${upid}`).catch(() => null)
    }
    const [aval, dem] = await Promise.all([avaliacoes(itemIds[0]), demanda(itemIds, dias)])
    return {
      ...base,
      avaliacoes: aval?.total ?? null,
      nota: aval?.nota ?? null,
      demanda: dem,
      item_ids: itemIds.slice(0, 3),
      nome: p?.name || reserva?.name || reserva?.family_name || null,
      marca: attr(p?.attributes, 'BRAND') || attr(reserva?.attributes, 'BRAND'),
      thumbnail: p?.pictures?.[0]?.url || reserva?.pictures?.[0]?.secure_url || reserva?.thumbnail || null,
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
    const u = await api(`/user-products/${entrada.id}`).catch(() => null)
    // quando o produto próprio aponta pro catálogo, aproveitamos o preço de lá
    let precos = [], nVend = null, categoryId = null, aval = null, dem = null, idsMedidos = []
    if (u?.catalog_product_id) {
      const itens = await api(`/products/${u.catalog_product_id}/items`).catch(() => null)
      const res = Array.isArray(itens?.results) ? itens.results : []
      precos = res.map((x) => x.price).filter((v) => v != null)
      nVend = itens?.paging?.total ?? res.length
      categoryId = res[0]?.category_id || null
      idsMedidos = res.map((x) => x.item_id).filter(Boolean)
      ;[aval, dem] = await Promise.all([avaliacoes(idsMedidos[0]), demanda(idsMedidos, dias)])
    }
    return {
      ...base,
      avaliacoes: aval?.total ?? null,
      nota: aval?.nota ?? null,
      demanda: dem,
      item_ids: idsMedidos.slice(0, 3),
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

  // ITEM: a API não abre os dados do anúncio pra token de aplicação, mas as
  // visitas e as avaliações desse anúncio continuam públicas.
  const [aval, dem] = await Promise.all([avaliacoes(entrada.id), demanda([entrada.id], dias)])
  return {
    ...base,
    nome: null,
    marca: null,
    thumbnail: null,
    preco_min: null,
    n_vend: null,
    avaliacoes: aval?.total ?? null,
    nota: aval?.nota ?? null,
    demanda: dem,
    item_ids: [entrada.id],
    url: `https://produto.mercadolivre.com.br/${String(entrada.id).replace('MLB', 'MLB-')}`,
    catalogo: false,
    sem_dados: true,
  }
}

// --- o ranking completo de uma categoria ----------------------------------
export async function getEmAlta(categoryId, diasPedido) {
  const cat = String(categoryId || '').trim()
  if (!cat) return { erro: 'sem_categoria', itens: [] }

  const dias = validarJanela(diasPedido)
  const chave = `alta:${cat}:${dias}`
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

  // resolve em blocos pra não disparar dezenas de chamadas de uma vez
  const itens = []
  for (let i = 0; i < conteudo.length; i += 4) {
    const bloco = await Promise.all(conteudo.slice(i, i + 4).map((e) => resolver(e, dias).catch(() => null)))
    itens.push(...bloco.filter(Boolean))
  }

  // movimento no ranking desde a última foto (o histórico é nosso, não do ML)
  const hist = registrarEComparar(cat, itens)
  for (const it of itens) it.movimento = hist.movimento[it.id] || null

  return guardar(chave, {
    categoria: { id: cat, nome: info?.name || null, path: info?.path || null },
    tipo_ranking: destaques?.query_data?.highlight_type || null,
    termos: (Array.isArray(termos) ? termos : []).slice(0, 12).map((t) => ({
      termo: t.keyword,
      url: t.url,
    })),
    historico: {
      comparado_com: hist.comparado_com,
      dias_guardados: hist.dias_guardados,
      janela_visitas: dias,
      janelas: JANELAS,
    },
    itens,
  })
}

// Termos mais buscados do site inteiro (sem categoria) — usado como atalho
// na tela quando ainda não há categoria escolhida.
export async function termosDoSite() {
  const chave = 'trends:site'
  const c = doCache(chave)
  if (c) return c
  const r = await api('/trends/MLB').catch(() => [])
  return guardar(chave, (Array.isArray(r) ? r : []).slice(0, 20).map((t) => ({ termo: t.keyword, url: t.url })))
}

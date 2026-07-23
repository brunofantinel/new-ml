import fs from 'node:fs'
import path from 'node:path'
import { api, avaliacoes, demanda } from './alta.js'

// ===========================================================================
// CATEGORIAS EM ALTA — qual seção do Mercado Livre está esquentando.
// ===========================================================================
// A API não publica faturamento nem venda por categoria. O que existe:
//
//   OFERTA   /categories/{id} -> total_items_in_this_category (1 chamada!)
//   PROCURA  /highlights + visitas dos produtos do topo (amostra do ranking)
//   VENDA    avaliações somadas desses mesmos produtos (só quem compra avalia)
//   BUSCA    /trends/MLB/{id} -> o que a categoria está procurando
//
// A leitura que interessa NÃO é "qual vende mais". Categoria campeã de venda
// é campeã de concorrência — pra conta nova isso é armadilha. O que vale é
// PROCURA POR ANÚNCIO: onde tem muita visita para pouca oferta.
//
// Limite honesto: a procura é medida numa AMOSTRA (os ~12 mais vendidos da
// categoria), não na categoria inteira. Serve pra comparar categorias entre si
// — é a mesma régua pra todas — não pra afirmar volume absoluto.

const DIR_DADOS = path.resolve(process.cwd(), 'dados')
const ARQ = path.join(DIR_DADOS, 'categorias-alta.json')
const ARQ_PRODUTOS = path.join(DIR_DADOS, 'produtos-em-alta.json')

// --- medição de UM produto do ranking da categoria ------------------------
// Só o que entra nas contas agregadas: preço, vendedores, avaliações e a
// série de visitas — e também nome/foto, porque a aba "Em alta" mostra o
// produto individual, não só o agregado da categoria.
async function medirProduto(entrada, dias) {
  let itemIds = [], precos = [], nVend = null, oficiais = 0
  let nome = null, marca = null, thumbnail = null, url = null, catalogId = null

  if (entrada.type === 'PRODUCT' || entrada.type === 'USER_PRODUCT') {
    catalogId = entrada.id
    if (entrada.type === 'USER_PRODUCT') {
      const u = await api(`/user-products/${entrada.id}`).catch(() => null)
      catalogId = u?.catalog_product_id || null
      nome = u?.name || u?.family_name || null
      marca = attrValor(u?.attributes, 'BRAND')
      thumbnail = u?.pictures?.[0]?.secure_url || u?.thumbnail || null
    }
    if (catalogId) {
      const [r, p] = await Promise.all([
        api(`/products/${catalogId}/items`).catch(() => null),
        entrada.type === 'PRODUCT' ? api(`/products/${catalogId}`).catch(() => null) : null,
      ])
      const res = Array.isArray(r?.results) ? r.results : []
      itemIds = res.map((x) => x.item_id).filter(Boolean)
      precos = res.map((x) => x.price).filter((v) => v != null)
      nVend = r?.paging?.total ?? res.length
      oficiais = res.filter((x) => x.official_store_id != null).length
      if (p) {
        nome = p.name || nome
        marca = attrValor(p.attributes, 'BRAND') || marca
        thumbnail = p.pictures?.[0]?.url || thumbnail
      }
      url = `https://www.mercadolivre.com.br/p/${catalogId}`
    }
  } else if (entrada.type === 'ITEM') {
    itemIds = [entrada.id]
    url = `https://produto.mercadolivre.com.br/${String(entrada.id).replace('MLB', 'MLB-')}`
  }
  if (!itemIds.length) return null

  // 1 anúncio por produto basta: a agregação já é feita sobre ~12 produtos
  const [aval, dem] = await Promise.all([
    avaliacoes(itemIds[0]),
    demanda([itemIds[0]], dias),
  ])
  if (!dem) return null

  return {
    id: entrada.id,
    tipo: entrada.type,
    posicao: entrada.position,
    nome, marca, thumbnail,
    url: url || `https://www.mercadolivre.com.br/p/${entrada.id}`,
    preco: precos.length ? Math.min(...precos) : null,
    n_vend: nVend,
    oficiais,
    avaliacoes: aval?.total ?? 0,
    nota: aval?.nota ?? null,
    visitas_dia: dem.visitas_dia,
    variacao: dem.variacao,
    direcao: dem.direcao,
    serie: dem.serie,
    item_ids: itemIds.slice(0, 3),
    // Medimos as visitas de 1 anúncio; num produto com dezenas de vendedores
    // isso é uma fatia pequena do tráfego total, e a tendência pode refletir
    // aquele anúncio específico perdendo posição, não o produto esfriando.
    amostra_fragil: (nVend || 0) > 6,
  }
}

const attrValor = (lista, id) => {
  const a = (lista || []).find((x) => x?.id === id)
  if (!a) return null
  return a.value_name || (Array.isArray(a.values) ? a.values[0]?.name : null) || null
}

const mediana = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100
}
const media = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null)

// --- análise completa de UMA categoria ------------------------------------
export async function analisarCategoria(catId, { dias = 30, top = 12 } = {}) {
  const [info, destaques, termos] = await Promise.all([
    api(`/categories/${catId}`).catch(() => null),
    api(`/highlights/MLB/category/${catId}`).catch(() => null),
    api(`/trends/MLB/${catId}`).catch(() => []),
  ])
  if (!info) return null

  const caminho = (info.path_from_root || []).map((p) => p.name)
  const base = {
    id: catId,
    nome: info.name || catId,
    path: caminho.join(' > '),
    nivel: caminho.length,
    pai: caminho.length > 1 ? (info.path_from_root[caminho.length - 2]?.id || null) : null,
    raiz: info.path_from_root?.[0]?.name || null,
    anuncios: info.total_items_in_this_category ?? null,
    filhas: (info.children_categories || []).length,
    termos: (Array.isArray(termos) ? termos : []).slice(0, 8).map((t) => t.keyword),
    permalink: info.permalink || null,
  }

  const conteudo = (destaques?.content || []).slice(0, top)
  if (!conteudo.length) {
    return { ...base, amostra: 0, sem_ranking: true }
  }

  // mede em blocos pra não estourar a API
  const medidos = []
  for (let i = 0; i < conteudo.length; i += 4) {
    const bloco = await Promise.all(
      conteudo.slice(i, i + 4).map((e) => medirProduto(e, dias).catch(() => null))
    )
    medidos.push(...bloco.filter(Boolean))
  }
  if (!medidos.length) return { ...base, amostra: 0, sem_ranking: true }

  // série diária da categoria = soma das séries dos produtos do topo
  const tamanho = Math.max(...medidos.map((m) => m.serie.length))
  const serie = new Array(tamanho).fill(0)
  for (const m of medidos) m.serie.forEach((v, i) => { serie[i] += v })

  const visitasDia = Math.round(medidos.reduce((s, m) => s + m.visitas_dia, 0) * 10) / 10
  const avaliacoesTotal = medidos.reduce((s, m) => s + (m.avaliacoes || 0), 0)
  const vendedores = medidos.map((m) => m.n_vend).filter((v) => v != null)
  const precos = medidos.map((m) => m.preco).filter((v) => v != null)
  const subindo = medidos.filter((m) => m.direcao === 'subindo').length
  const caindo = medidos.filter((m) => m.direcao === 'caindo').length
  const estavel = medidos.length - subindo - caindo

  // procura por oferta: visitas/dia da amostra para cada 100 mil anúncios da
  // categoria. É a razão que separa "quente" de "quente e disputado".
  const porOferta = base.anuncios
    ? Math.round((visitasDia / base.anuncios) * 100000 * 100) / 100
    : null

  // metades da janela, agora no nível da categoria
  const meio = Math.floor(serie.length / 2)
  const antigo = serie.slice(0, meio).reduce((a, b) => a + b, 0)
  const recente = serie.slice(meio).reduce((a, b) => a + b, 0)
  let direcao = 'estavel'
  let variacao = antigo > 0 ? Math.round(((recente - antigo) / antigo) * 100) : null
  if (recente > antigo * 1.15) direcao = 'subindo'
  else if (recente < antigo * 0.85) direcao = 'caindo'

  return {
    ...base,
    amostra: medidos.length,
    visitas_dia: visitasDia,
    visitas_por_100k_anuncios: porOferta,
    avaliacoes: avaliacoesTotal,
    preco_mediano: mediana(precos),
    vendedores_medio: media(vendedores),
    oficiais_pct: medidos.length
      ? Math.round((medidos.filter((m) => m.oficiais > 0).length / medidos.length) * 100)
      : null,
    subindo, estavel, caindo,
    direcao, variacao,
    serie,
    janela_dias: dias,
    // detalhe produto a produto — vira a aba "Em alta"
    produtos: medidos,
  }
}

// ---------------------------------------------------------------------------
// PRODUTOS EM ALTA — o que está subindo, de todas as categorias varridas.
// ---------------------------------------------------------------------------
// Achatamos os produtos medidos em cada categoria e ranqueamos por
// crescimento. Duas travas, aprendidas na marra:
//  - piso de tráfego: sem ele, 1 -> 4 visitas vira "+300%" e lidera a lista;
//  - o crescimento é ponderado pelo tamanho, senão um produto de 40 visitas/dia
//    com +200% passa na frente de um de 4.000/dia com +60%.
const PISO_VISITAS_PRODUTO = 30

export function montarProdutosEmAlta(categorias, { piso = PISO_VISITAS_PRODUTO } = {}) {
  const saida = []
  for (const c of categorias) {
    for (const p of c.produtos || []) {
      if (p.direcao !== 'subindo') continue
      if (p.visitas_dia < piso) continue
      if (p.variacao == null) continue

      // tamanho (satura em 3.000 visitas/dia) × força do crescimento (satura
      // em +150%). Multiplicação, não soma: precisa das duas coisas.
      const porte = Math.min(1, Math.log10(1 + p.visitas_dia) / Math.log10(1 + 3000))
      const forca = Math.min(1, p.variacao / 150)
      saida.push({
        ...p,
        categoria: { id: c.id, nome: c.nome, path: c.path },
        score: Math.round(100 * (0.55 * porte + 0.45 * forca)),
      })
    }
  }
  return saida.sort((a, b) => b.score - a.score)
}

// --- pontuação -------------------------------------------------------------
// 40% procura por oferta (a oportunidade), 30% crescimento, 30% folga de
// concorrência. Procura bruta NÃO entra sozinha de propósito: categoria com
// muita visita e milhões de anúncios não é oportunidade, é multidão.
const limitar = (v, a, b) => Math.max(a, Math.min(b, v))

// Abaixo disto a categoria é pequena demais para a razão significar alguma
// coisa: 300 visitas/dia somando os ~12 produtos mais vendidos da categoria
// INTEIRA. Na varredura completa a mediana ficou em ~1.550/dia e o percentil 10
// em ~180, então 300 separa nicho minúsculo de categoria de verdade.
const PISO_VISITAS_DIA = 300

export function pontuar(c, referencia) {
  if (!c || !c.amostra) return { ...c, temperatura: null }
  const maxPorOferta = referencia?.maxPorOferta || 1

  const oportunidade = c.visitas_por_100k_anuncios != null
    ? limitar(Math.log10(1 + c.visitas_por_100k_anuncios) / Math.log10(1 + maxPorOferta), 0, 1)
    : 0
  const crescimento = limitar(((c.subindo - c.caindo) / c.amostra + 1) / 2, 0, 1)
  const folga = c.vendedores_medio != null ? 1 / (1 + c.vendedores_medio / 10) : 0.5

  const bruto = 100 * (0.40 * oportunidade + 0.30 * crescimento + 0.30 * folga)

  // Fator de PORTE. Sem ele, categoria minúscula vira "oportunidade" só porque
  // tem pouquíssimo anúncio: "Criptomoedas" tirava 74 com 9,6 visitas/dia. É
  // multiplicador e não parcela de propósito — acima do piso ele some, e a
  // ordem entre as categorias de verdade continua sendo procura por oferta.
  const porte = limitar(
    Math.log10(1 + c.visitas_dia) / Math.log10(1 + PISO_VISITAS_DIA), 0, 1
  )
  const temperatura = Math.round(bruto * porte)

  // leitura em palavras, que é o que a tela mostra
  let leitura
  if (c.visitas_dia < PISO_VISITAS_DIA) leitura = 'nicho pequeno'
  else if (temperatura >= 65) leitura = 'oportunidade'
  else if (c.direcao === 'subindo' && c.vendedores_medio > 20) leitura = 'esquentando mas disputada'
  else if (c.direcao === 'caindo') leitura = 'esfriando'
  else if (c.vendedores_medio > 25) leitura = 'muito disputada'
  else leitura = 'morna'

  return { ...c, temperatura, leitura, porte: Math.round(porte * 100) }
}

// --- arquivo gerado pelo job ----------------------------------------------
export function lerRelatorio() {
  try {
    return JSON.parse(fs.readFileSync(ARQ, 'utf8'))
  } catch {
    return null
  }
}

export function gravarRelatorio(dados) {
  fs.mkdirSync(DIR_DADOS, { recursive: true })
  fs.writeFileSync(ARQ, JSON.stringify(dados))
  return ARQ
}

export function lerProdutos() {
  try {
    return JSON.parse(fs.readFileSync(ARQ_PRODUTOS, 'utf8'))
  } catch {
    return null
  }
}

export function gravarProdutos(dados) {
  fs.mkdirSync(DIR_DADOS, { recursive: true })
  fs.writeFileSync(ARQ_PRODUTOS, JSON.stringify(dados))
  return ARQ_PRODUTOS
}

export const CAMINHO_RELATORIO = ARQ
export const CAMINHO_PRODUTOS = ARQ_PRODUTOS

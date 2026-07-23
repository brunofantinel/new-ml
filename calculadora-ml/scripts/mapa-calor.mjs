// ===========================================================================
// MAPA DE CALOR — quais produtos vale a pena anunciar primeiro.
// ===========================================================================
// Parte da analise que ja existe (public/vantagens.json: 1.856 produtos da
// planilha ja casados com o catalogo do ML e com a margem calculada) e junta
// o que faltava: a PROCURA de verdade, medida pelas visitas dos anuncios do
// concorrente — a mesma logica do termometro do app.
//
// Nao usa o ERP. So a planilha (via vantagens.json) + API do Mercado Livre.
//
// Uso:
//   node scripts/mapa-calor.mjs [--dias=60] [--limite=N] [--tier=competir]
//
// Escreve:
//   ../RANKING_ANUNCIAR_ML.csv   (ranking pronto pra abrir no Excel)
//   .cache-visitas.json          (cache pra re-rodar sem gastar API de novo)
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mlGet } from '../server/ml.js'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const RAIZ = path.resolve(AQUI, '..')
const ENTRADA = path.join(RAIZ, 'public', 'vantagens.json')
const CACHE = path.join(RAIZ, '.cache-visitas.json')
const SAIDA_CSV = path.resolve(RAIZ, '..', 'RANKING_ANUNCIAR_ML.csv')
const SAIDA_JSON = path.resolve(RAIZ, '..', 'ranking-anunciar-ml.json')

const arg = (nome, padrao) => {
  const a = process.argv.find((x) => x.startsWith(`--${nome}=`))
  return a ? a.split('=')[1] : padrao
}
const DIAS = Number(arg('dias', 60))
const LIMITE = Number(arg('limite', 0)) // 0 = todos
const TIER = arg('tier', '') // vazio = todos os tiers
const CONCORRENCIA = Number(arg('par', 6))
const MAX_ANUNCIOS = 3 // quantos anuncios do mesmo produto medir (sinal menos ruidoso)

// --- cache em disco: re-rodar nao gasta API de novo ------------------------
let cache = {}
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch {}
let cacheSujo = 0
function salvarCache(forcar = false) {
  if (!cacheSujo) return
  if (!forcar && cacheSujo % 25 !== 0) return
  fs.writeFileSync(CACHE, JSON.stringify(cache))
}

// --- API com retentativa em 429/5xx ---------------------------------------
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(rota, tentativas = 4) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await mlGet(rota)
    } catch (e) {
      const s = e.status || 0
      if (s === 404 || s === 403) throw e            // nao adianta insistir
      if (i === tentativas - 1) throw e
      await dormir(600 * 2 ** i)                      // 0,6s / 1,2s / 2,4s
    }
  }
}

// --- coleta de UM produto --------------------------------------------------
// 1 chamada pro catalogo (vendedores e preco de hoje) + ate 3 de visitas.
async function coletar(p) {
  const chave = `${p.catalog_id}|${DIAS}`
  if (cache[chave]) return cache[chave]

  const out = { erro: null, n_vend: null, preco_agora: null, visitas: null, recente: null, antigo: null, n_medidos: 0 }

  // vendedores e preco de agora
  let itemIds = []
  try {
    const r = await api(`/products/${p.catalog_id}/items`)
    const res = Array.isArray(r?.results) ? r.results : []
    out.n_vend = r?.paging?.total ?? res.length
    const precos = res.map((x) => x.price).filter((v) => v != null)
    out.preco_agora = precos.length ? Math.min(...precos) : null
    itemIds = res.map((x) => x.item_id).filter(Boolean).slice(0, MAX_ANUNCIOS)
  } catch (e) {
    out.erro = `catalogo_${e.status || 'erro'}`
  }
  // o anuncio do concorrente que a analise ja tinha entra na medicao
  if (p.conc_id && !itemIds.includes(p.conc_id)) itemIds.unshift(p.conc_id)
  itemIds = itemIds.slice(0, MAX_ANUNCIOS)

  // visitas por dia, somadas entre os anuncios do mesmo produto
  const corte = Date.now() - (DIAS / 2) * 24 * 3600 * 1000
  let total = 0, recente = 0, antigo = 0, ok = 0
  for (const id of itemIds) {
    try {
      const v = await api(`/items/${id}/visits/time_window?last=${DIAS}&unit=day`)
      ok++
      for (const ponto of v?.results || []) {
        const n = Number(ponto?.total) || 0
        if (!n) continue
        total += n
        const ts = new Date(String(ponto.date).slice(0, 10) + 'T00:00:00Z').getTime()
        if (ts >= corte) recente += n
        else antigo += n
      }
    } catch { /* anuncio sem visita publica: ignora */ }
  }
  if (ok) {
    out.visitas = total
    out.recente = recente
    out.antigo = antigo
    out.n_medidos = ok
  } else if (!out.erro) {
    out.erro = 'sem_visitas'
  }

  cache[chave] = out
  cacheSujo++
  salvarCache()
  return out
}

// --- pontuacao -------------------------------------------------------------
const limitar = (v, a, b) => Math.max(a, Math.min(b, v))

function pontuar(p, c) {
  const visitasDia = c.visitas != null ? c.visitas / DIAS : 0

  // Margem no preco de HOJE (o da analise pode ter mudado). A comissao do ML e
  // proporcional ao preco, entao reaplicamos a mesma taxa efetiva; custo
  // operacional e frete sao fixos por venda.
  const precoRef = c.preco_agora ?? p.preco_conc
  const taxaEfetiva = p.preco_conc > 0 ? (p.comissao || 0) / p.preco_conc : 0
  const custoMlHoje = precoRef * taxaEfetiva + (p.custo_op || 0) + (p.frete || 0)
  const sobraHoje = precoRef - (p.custo || 0) - custoMlHoje
  const sobraPctHoje = precoRef > 0 ? sobraHoje / precoRef : 0

  // Demanda: valor ABSOLUTO de visitas/dia, em escala log (satura em ~30/dia).
  // De proposito NAO usamos o % de crescimento: em produto de baixa visita ele
  // e ruido (1 -> 4 visitas vira "+300%").
  const demanda = limitar(Math.log10(1 + visitasDia) / Math.log10(1 + 30), 0, 1)
  const margem = limitar(sobraPctHoje / 0.35, 0, 1)
  const nVend = c.n_vend ?? p.n_vend ?? 0
  let concorrencia = 1 / (1 + nVend / 5)
  if ((p.n_oficiais || 0) > 0) concorrencia *= 0.5 // loja oficial no anuncio derruba conta nova

  const score = Math.round(100 * (0.40 * demanda + 0.35 * margem + 0.25 * concorrencia))

  // tendencia so vale a pena olhar quando ha trafego que sustente
  let tendencia = 'sem dados'
  if (c.visitas != null) {
    if (c.visitas < 15) tendencia = 'trafego fraco'
    else if (c.recente > c.antigo * 1.15) tendencia = 'subindo'
    else if (c.recente < c.antigo * 0.85) tendencia = 'caindo'
    else tendencia = 'estavel'
  }

  // acao recomendada
  let acao
  if (sobraPctHoje < 0.12 || visitasDia < 0.2) acao = 'NAO AGORA'
  else if (sobraPctHoje >= 0.15 && visitasDia >= 1 && (p.n_oficiais || 0) === 0 && nVend <= 15) acao = 'ANUNCIAR JA'
  else if (sobraPctHoje >= 0.12 && visitasDia >= 0.5) acao = 'SEGUNDA RODADA'
  else acao = 'SO COM CUIDADO'

  const motivos = []
  if (visitasDia < 0.2) motivos.push('quase ninguem procura')
  if (sobraPctHoje < 0.12) motivos.push('margem abaixo de 12%')
  if ((p.n_oficiais || 0) > 0) motivos.push('tem loja oficial vendendo')
  if (nVend > 15) motivos.push(`${nVend} concorrentes`)
  if (c.n_vend === 0) motivos.push('ninguem vendendo hoje')
  if (c.preco_agora != null && p.preco_conc > 0) {
    const varPct = (c.preco_agora - p.preco_conc) / p.preco_conc
    if (varPct <= -0.05) motivos.push(`concorrente baixou ${Math.round(-varPct * 100)}%`)
  }

  return { visitasDia, precoRef, sobraHoje, sobraPctHoje, demanda, margem, concorrencia, score, tendencia, acao, nVend, motivos }
}

// --- fila com paralelismo limitado ----------------------------------------
async function emLote(itens, n, fn) {
  const saida = new Array(itens.length)
  let i = 0
  const trabalhador = async () => {
    while (i < itens.length) {
      const meu = i++
      try { saida[meu] = await fn(itens[meu], meu) } catch (e) { saida[meu] = { erro: String(e?.message || e) } }
      if ((meu + 1) % 50 === 0) {
        process.stdout.write(`\r  ${meu + 1}/${itens.length} produtos medidos…`)
      }
    }
  }
  await Promise.all(Array.from({ length: n }, trabalhador))
  process.stdout.write(`\r  ${itens.length}/${itens.length} produtos medidos.   \n`)
  return saida
}

// --- CSV -------------------------------------------------------------------
const br = (n, casas = 2) => (n == null || Number.isNaN(n) ? '' : n.toFixed(casas).replace('.', ','))
const txt = (s) => {
  const v = String(s ?? '').replace(/"/g, '""')
  return /[;"\n]/.test(v) ? `"${v}"` : v
}

const COLUNAS = [
  'POSICAO', 'SCORE', 'ACAO', 'COD_PRODUTO', 'PRODUTO', 'MARCA', 'GRUPO',
  'CUSTO', 'PRECO_PRA_COMPETIR', 'SOBRA_RS', 'SOBRA_PCT',
  'VISITAS_JANELA', 'VISITAS_DIA', 'TENDENCIA',
  'CONCORRENTES', 'LOJAS_OFICIAIS', 'ANUNCIOS_MEDIDOS',
  'PRECO_NA_ANALISE', 'SOBRA_PCT_NA_ANALISE', 'TIER', 'VERIFICACAO',
  'POR_QUE', 'URL_CATALOGO', 'URL_CONCORRENTE',
]

function linhaCsv(r, i) {
  return [
    i + 1, r.s.score, r.s.acao, r.p.cod, r.p.produto, r.p.marca, r.p.grupo,
    br(r.p.custo), br(r.s.precoRef), br(r.s.sobraHoje), br(r.s.sobraPctHoje * 100, 1),
    r.c.visitas ?? '', br(r.s.visitasDia, 2), r.s.tendencia,
    r.s.nVend, r.p.n_oficiais ?? '', r.c.n_medidos,
    br(r.p.preco_conc), br((r.p.margem_pct || 0) * 100, 1), r.p.tier, r.p.verif,
    r.s.motivos.join(' · '), r.p.url_cat, r.p.url_conc,
  ].map(txt).join(';')
}

// --- principal -------------------------------------------------------------
const t0 = Date.now()
const base = JSON.parse(fs.readFileSync(ENTRADA, 'utf8'))
let itens = base.itens
if (TIER) itens = itens.filter((x) => x.tier === TIER)
if (LIMITE > 0) itens = itens.slice(0, LIMITE)

console.log(`Mapa de calor — ${itens.length} produtos da planilha (analise de ${base.data_pesquisa}).`)
console.log(`Janela de visitas: ${DIAS} dias · ate ${MAX_ANUNCIOS} anuncios por produto · ${CONCORRENCIA} em paralelo.`)
const jaEmCache = itens.filter((p) => cache[`${p.catalog_id}|${DIAS}`]).length
if (jaEmCache) console.log(`${jaEmCache} ja estavam no cache — nao gastam API.`)

const coletas = await emLote(itens, CONCORRENCIA, (p) => coletar(p))
salvarCache(true)

const linhas = itens
  .map((p, i) => {
    const c = coletas[i] || {}
    return { p, c, s: pontuar(p, c) }
  })
  .sort((a, b) => b.s.score - a.s.score)

fs.writeFileSync(
  SAIDA_CSV,
  '﻿' + COLUNAS.join(';') + '\n' + linhas.map(linhaCsv).join('\n') + '\n',
  'utf8'
)
fs.writeFileSync(SAIDA_JSON, JSON.stringify({
  gerado_de: 'public/vantagens.json',
  data_analise_precos: base.data_pesquisa,
  janela_dias: DIAS,
  total: linhas.length,
  itens: linhas.map((r, i) => ({
    pos: i + 1, score: r.s.score, acao: r.s.acao, cod: r.p.cod, produto: r.p.produto,
    marca: r.p.marca, grupo: r.p.grupo, custo: r.p.custo, preco: r.s.precoRef,
    sobra_rs: r.s.sobraHoje, sobra_pct: r.s.sobraPctHoje,
    visitas: r.c.visitas ?? null, visitas_dia: r.s.visitasDia, tendencia: r.s.tendencia,
    n_vend: r.s.nVend, n_oficiais: r.p.n_oficiais ?? null, anuncios_medidos: r.c.n_medidos,
    tier: r.p.tier, motivos: r.s.motivos, url_cat: r.p.url_cat, url_conc: r.p.url_conc,
  })),
}, null, 1), 'utf8')

// --- resumo no terminal ----------------------------------------------------
const conta = (a) => linhas.filter((r) => r.s.acao === a).length
console.log(`\nPronto em ${Math.round((Date.now() - t0) / 1000)}s`)
console.log(`  ANUNCIAR JA .... ${conta('ANUNCIAR JA')}`)
console.log(`  SEGUNDA RODADA . ${conta('SEGUNDA RODADA')}`)
console.log(`  SO COM CUIDADO . ${conta('SO COM CUIDADO')}`)
console.log(`  NAO AGORA ...... ${conta('NAO AGORA')}`)
console.log(`  sem visita publica: ${linhas.filter((r) => r.c.visitas == null).length}`)
console.log(`\nCSV: ${SAIDA_CSV}`)
console.log('\nTop 15:')
for (const [i, r] of linhas.slice(0, 15).entries()) {
  console.log(
    `${String(i + 1).padStart(3)}. [${String(r.s.score).padStart(2)}] ${r.s.acao.padEnd(15)} ` +
    `${String(r.p.produto).slice(0, 46).padEnd(46)} ` +
    `sobra ${br(r.s.sobraPctHoje * 100, 0)}% · ${br(r.s.visitasDia, 1)} vis/dia · ${r.s.nVend} conc.`
  )
}

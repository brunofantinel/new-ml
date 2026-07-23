// ===========================================================================
// JOB: CATEGORIAS EM ALTA
// ===========================================================================
// Varre as seções do Mercado Livre e as subcategorias de cada uma, medindo
// oferta, procura, venda acumulada e crescimento. Escreve um relatório pronto
// em dados/categorias-alta.json — a tela só lê esse arquivo e abre instantânea.
//
// Não dá pra fazer isso ao vivo: são milhares de chamadas. Por isso é job.
//
// Uso:
//   node scripts/categorias-alta.mjs                    # tudo (seções + filhas)
//   node scripts/categorias-alta.mjs --so-raizes        # só as ~30 seções
//   node scripts/categorias-alta.mjs --dias=60 --top=15
//   node scripts/categorias-alta.mjs --raiz=MLB1132     # uma seção e as filhas dela
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { api } from '../server/alta.js'
import {
  analisarCategoria, pontuar, montarProdutosEmAlta,
  gravarRelatorio, gravarProdutos, CAMINHO_RELATORIO, CAMINHO_PRODUTOS,
} from '../server/categorias.js'

const arg = (nome, padrao) => {
  const a = process.argv.find((x) => x.startsWith(`--${nome}=`))
  return a ? a.split('=')[1] : padrao
}
const tem = (nome) => process.argv.includes(`--${nome}`)

const DIAS = Number(arg('dias', 30))
const TOP = Number(arg('top', 12))
const PAR = Number(arg('par', 4))
const SO_RAIZES = tem('so-raizes')
const SO_RAIZ = arg('raiz', '')

const CACHE = path.resolve(process.cwd(), '.cache-categorias.json')
let cache = {}
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch {}
let sujo = 0
const salvarCache = (forcar) => {
  if (!sujo) return
  if (!forcar && sujo % 10 !== 0) return
  try { fs.writeFileSync(CACHE, JSON.stringify(cache)) } catch {}
}

async function emLote(itens, n, fn) {
  const saida = new Array(itens.length)
  let i = 0, feitos = 0
  const trabalhador = async () => {
    while (i < itens.length) {
      const meu = i++
      try { saida[meu] = await fn(itens[meu]) } catch { saida[meu] = null }
      feitos++
      if (feitos % 5 === 0 || feitos === itens.length) {
        process.stdout.write(`\r  ${feitos}/${itens.length} categorias analisadas…   `)
      }
    }
  }
  await Promise.all(Array.from({ length: n }, trabalhador))
  process.stdout.write('\n')
  return saida
}

// --- monta a lista de categorias a analisar -------------------------------
console.log('Categorias em alta — montando a lista…')
let raizes = await api('/sites/MLB/categories')
if (SO_RAIZ) raizes = raizes.filter((r) => r.id === SO_RAIZ)

const alvos = raizes.map((r) => ({ id: r.id, nome: r.name }))
if (!SO_RAIZES) {
  const detalhes = await Promise.all(
    raizes.map((r) => api(`/categories/${r.id}`).catch(() => null))
  )
  for (const d of detalhes) {
    for (const f of d?.children_categories || []) alvos.push({ id: f.id, nome: f.name })
  }
}

const jaTem = alvos.filter((a) => cache[`v2|${a.id}|${DIAS}|${TOP}`]).length
console.log(`${alvos.length} categorias (${raizes.length} seções${SO_RAIZES ? '' : ' + subcategorias'}).`)
console.log(`Janela ${DIAS} dias · top ${TOP} produtos por categoria · ${PAR} em paralelo.`)
if (jaTem) console.log(`${jaTem} já estavam no cache — não gastam API.`)

// --- analisa ---------------------------------------------------------------
const t0 = Date.now()
const brutos = await emLote(alvos, PAR, async (alvo) => {
  const chave = `v2|${alvo.id}|${DIAS}|${TOP}`
  if (cache[chave]) return cache[chave]
  const r = await analisarCategoria(alvo.id, { dias: DIAS, top: TOP })
  cache[chave] = r
  sujo++
  salvarCache()
  return r
})
salvarCache(true)

const analisadas = brutos.filter(Boolean)
const comAmostra = analisadas.filter((c) => c.amostra > 0)

// --- pontua (a régua depende do conjunto, então é feita no fim) ------------
const maxPorOferta = Math.max(...comAmostra.map((c) => c.visitas_por_100k_anuncios || 0), 1)
const pontuadas = comAmostra
  .map((c) => pontuar(c, { maxPorOferta }))
  .sort((a, b) => b.temperatura - a.temperatura)

// --- relatorio 1: categorias ---------------------------------------------
// o detalhe produto a produto sai daqui (vai no relatorio 2), senao o arquivo
// que a tela de categorias baixa fica varias vezes maior a toa
const relatorio = {
  janela_dias: DIAS,
  top_por_categoria: TOP,
  total_analisadas: analisadas.length,
  com_ranking: pontuadas.length,
  sem_ranking: analisadas.filter((c) => !c.amostra).map((c) => ({ id: c.id, nome: c.nome, path: c.path })),
  max_por_oferta: maxPorOferta,
  categorias: pontuadas.map(({ produtos, ...resto }) => resto),
}
gravarRelatorio(relatorio)

// --- relatorio 2: produtos em alta ---------------------------------------
const emAlta = montarProdutosEmAlta(pontuadas)
gravarProdutos({
  janela_dias: DIAS,
  categorias_varridas: pontuadas.length,
  produtos_medidos: pontuadas.reduce((s, c) => s + (c.produtos?.length || 0), 0),
  total: emAlta.length,
  produtos: emAlta,
})

// --- resumo ---------------------------------------------------------------
const seg = Math.round((Date.now() - t0) / 1000)
console.log(`\nPronto em ${Math.floor(seg / 60)}min ${seg % 60}s`)
console.log(`  com ranking: ${pontuadas.length}`)
console.log(`  sem ranking publicado pelo ML: ${relatorio.sem_ranking.length}`)
console.log(`  arquivo: ${CAMINHO_RELATORIO}`)
console.log(`  produtos subindo: ${emAlta.length} (de ${pontuadas.reduce((s, c) => s + (c.produtos?.length || 0), 0)} medidos)`)
console.log(`  arquivo: ${CAMINHO_PRODUTOS}`)

const fmt = (n) => (n == null ? '—' : n.toLocaleString('pt-BR'))
console.log('\nTop 15 por temperatura:')
for (const [i, c] of pontuadas.slice(0, 15).entries()) {
  console.log(
    `${String(i + 1).padStart(3)}. [${String(c.temperatura).padStart(2)}] ${String(c.path || c.nome).slice(0, 48).padEnd(48)} ` +
    `${fmt(c.visitas_dia).padStart(9)} vis/dia · ${fmt(c.anuncios).padStart(10)} anúncios · ` +
    `${String(c.visitas_por_100k_anuncios).padStart(7)} por 100k · ${c.leitura}`
  )
}

console.log('\nTop 10 produtos em alta:')
for (const [i, p] of emAlta.slice(0, 10).entries()) {
  console.log(
    `${String(i + 1).padStart(3)}. [${String(p.score).padStart(2)}] ${String(p.nome || p.id).slice(0, 44).padEnd(44)} ` +
    `${String(p.visitas_dia).padStart(8)} vis/dia +${p.variacao}% · ${p.n_vend ?? '?'} vend · ${p.categoria.nome.slice(0, 22)}`
  )
}

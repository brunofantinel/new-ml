import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { mlGet, predictCategory } from '../server/ml.js'
import { findWinner } from '../server/catalog.js'

// ---------------------------------------------------------------------------
// ANÁLISE COMPLETA — junta numa planilha só:
//   (1) SEU LUCRO: preço mínimo pra empatar e pra ter a margem-alvo (comissão real) — 100% dos produtos
//   (2) CONCORRENTE: preço praticado no catálogo do ML, quando existe, pra você ficar por dentro
//
// Uso:
//   node scripts/analise.js ../estoq.csv --margem 20 --limit 50
//   node scripts/analise.js ../estoq.csv --margem 30
//
// Opções: --margem N | --limit N | --out FILE | --conc N | --ativos (prod.csv, só ATIVO=S)
// Retomável: se parar, rode de novo que ele continua de onde parou.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const inputFile = args.find((a) => !a.startsWith('--')) || '../estoq.csv'
const margemAlvo = Number(val('margem', '20')) / 100
const mPct = Math.round(margemAlvo * 100)
const limit = val('limit') ? Number(val('limit')) : Infinity
const outFile = val('out', 'analise_completa.csv')
const somenteAtivos = args.includes('--ativos')
const CONC = Number(val('conc', '4'))

const ROOT = path.resolve(process.cwd())
const inputPath = path.resolve(ROOT, inputFile)
const outputPath = path.resolve(ROOT, outFile)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function parseCusto(raw) {
  if (!raw) return 0
  const s = String(raw).replace(/r\$/i, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s); return Number.isFinite(n) ? n : 0
}
function csvCell(v) { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
function readCsvLatin1(file) {
  const text = new TextDecoder('windows-1252').decode(fs.readFileSync(file))
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const header = lines[0].split(';').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cols = line.split(';'); const row = {}
    header.forEach((h, i) => (row[h] = (cols[i] ?? '').trim())); return row
  })
}
const money = (v) => (v == null ? '' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

const OUT_HEADER = [
  'COD_PRODUTO', 'PRODUTO', 'MARCA', 'CUSTO', 'CATEGORIA_ML', 'COMISSAO_PCT',
  'PRECO_EMPATE', `PRECO_${mPct}PCT`,
  'PRECO_CONCORRENTE', `FOLGA_VS_CONCORRENTE`, 'VEREDITO', 'OBS',
]

async function withRetry(fn, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) {
      last = e
      if (e.status === 429 || e.status >= 500) { await sleep(700 * 2 ** i); continue }
      throw e
    }
  }
  throw last
}

async function comissaoPct(refPrice, categoryId) {
  const p = new URLSearchParams({ price: String(refPrice), currency_id: 'BRL', listing_type_id: 'gold_special' })
  if (categoryId) p.set('category_id', categoryId)
  const r = await mlGet(`/sites/MLB/listing_prices?${p}`)
  const e = Array.isArray(r) ? (r.find((x) => x.listing_type_id === 'gold_special') || r[0]) : r
  return e?.sale_fee_details?.percentage_fee ?? null
}

async function processar(row) {
  const cod = row.COD_PRODUTO, nome = row.PRODUTO || '', marca = row.MARCA || ''
  const custo = parseCusto(row.ULTIMO_CUSTO)
  const base = { COD_PRODUTO: cod, PRODUTO: nome, MARCA: marca, CUSTO: money(custo) }
  if (custo <= 0) return { ...base, OBS: 'sem custo no CSV' }

  // (2) concorrente — também nos dá a categoria de graça quando acha
  let winner = { matched: false }
  try { winner = await withRetry(() => findWinner(nome)) } catch {}

  // categoria: usa a do concorrente se houver; senão tenta prever pelo nome
  let categoryId = winner.matched ? winner.category_id : ''
  let categoryName = ''
  if (!categoryId) {
    try { const c = await withRetry(() => predictCategory(nome)); if (c[0]) { categoryId = c[0].category_id; categoryName = c[0].category_name } } catch {}
  }

  // (1) comissão real -> preços mínimos
  let pct
  try {
    pct = await withRetry(() => comissaoPct(Math.max(custo * 3, 25), categoryId))
    if (pct == null && categoryId) pct = await withRetry(() => comissaoPct(Math.max(custo * 3, 25), ''))
  } catch (e) { return { ...base, OBS: 'erro comissão: ' + (e.data?.message || e.message || '').slice(0, 60) } }
  if (pct == null) return { ...base, OBS: 'sem comissão' }

  const p = pct / 100
  const empate = custo / (1 - p)
  const alvo = (1 - p - margemAlvo) > 0 ? custo / (1 - p - margemAlvo) : null

  // comparação com concorrente
  const precoConc = winner.matched ? Number(winner.price) : null
  const folga = precoConc != null && alvo != null ? precoConc - alvo : null
  let veredito
  if (precoConc == null) veredito = 'sem preço de concorrente'
  else if (alvo == null) veredito = 'margem impossível'
  else if (alvo <= precoConc) veredito = `dá pra competir com ${mPct}%`
  else veredito = 'concorrente mais barato'

  return {
    ...base,
    CATEGORIA_ML: categoryName ? `${categoryName} (${categoryId})` : (categoryId || 'padrão'),
    COMISSAO_PCT: String(pct),
    PRECO_EMPATE: money(empate),
    [`PRECO_${mPct}PCT`]: alvo != null ? money(alvo) : 'margem impossível',
    PRECO_CONCORRENTE: money(precoConc),
    FOLGA_VS_CONCORRENTE: folga != null ? money(folga) : '',
    VEREDITO: veredito,
    OBS: precoConc == null && winner.reason === 'catalogo_sem_preco' ? 'catálogo sem vendedor ativo' : '',
  }
}

async function main() {
  if (!process.env.ML_CLIENT_ID || !process.env.ML_CLIENT_SECRET) { console.error('\n❌ Faltam ML_CLIENT_ID/SECRET no .env\n'); process.exit(1) }
  if (!fs.existsSync(inputPath)) { console.error(`\n❌ Não achei: ${inputPath}\n`); process.exit(1) }

  let rows = readCsvLatin1(inputPath)
  if (somenteAtivos) rows = rows.filter((r) => (r.ATIVO || '').toUpperCase() === 'S')

  const done = new Set()
  if (fs.existsSync(outputPath)) {
    for (const l of fs.readFileSync(outputPath, 'utf8').split(/\r?\n/).slice(1)) {
      const c = l.split(';')[0]?.replace(/^"|"$/g, ''); if (c) done.add(c)
    }
    console.log(`↩  Retomando: ${done.size} já feitos.`)
  } else {
    fs.writeFileSync(outputPath, '﻿' + OUT_HEADER.join(';') + '\n')
  }

  let pending = rows.filter((r) => r.COD_PRODUTO && !done.has(r.COD_PRODUTO))
  if (Number.isFinite(limit)) pending = pending.slice(0, limit)
  const total = pending.length
  console.log(`\n▶  ${total} produtos · margem ${mPct}% · custo + preço mínimo + concorrente\n`)

  let idx = 0, ok = 0, comConc = 0, competir = 0
  async function worker() {
    while (idx < pending.length) {
      const my = idx++
      const res = await processar(pending[my])
      fs.appendFileSync(outputPath, OUT_HEADER.map((h) => csvCell(res[h])).join(';') + '\n')
      if (res.PRECO_EMPATE) ok++
      if (res.PRECO_CONCORRENTE) comConc++
      if (String(res.VEREDITO || '').startsWith('dá pra competir')) competir++
      const n = my + 1
      if (n % 10 === 0 || n === total) process.stdout.write(`  ${n}/${total}  preço-ok:${ok} c/concorrente:${comConc} competir:${competir}\r`)
      await sleep(120)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, total || 1) }, worker))
  console.log(`\n\n✅ Salvo em ${outFile}`)
  console.log(`   ${ok} com preço calculado · ${comConc} com preço de concorrente · ${competir} dá pra competir\n`)
}

main().catch((e) => { console.error('\n❌', e.message); process.exit(1) })

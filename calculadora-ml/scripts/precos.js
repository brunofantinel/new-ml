import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { mlGet, predictCategory } from '../server/ml.js'

// ---------------------------------------------------------------------------
// SIMULADOR DE PREÇO MÍNIMO — com as taxas REAIS do Mercado Livre.
//
// Para cada produto do seu CSV (que só tem o CUSTO), calcula:
//   - a comissão real da categoria (via API listing_prices)
//   - o preço mínimo pra empatar (break-even)
//   - o preço mínimo pra ter a margem-alvo que você escolher
//
// Uso:
//   node scripts/precos.js ../estoq.csv --margem 20 --limit 50
//   node scripts/precos.js ../estoq.csv --margem 30 --sem-categoria   (mais rápido, comissão padrão)
//
// Opções:
//   --margem N        margem líquida alvo em % (padrão 20)
//   --limit N         só os N primeiros (teste)
//   --out FILE        saída (padrão precos_minimos.csv)
//   --sem-categoria   não detecta a categoria (usa comissão padrão do ML; +rápido)
//   --conc N          paralelismo (padrão 4)
//   --ativos          (prod.csv) só ATIVO = S
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const inputFile = args.find((a) => !a.startsWith('--')) || '../estoq.csv'
const margemAlvo = Number(val('margem', '20')) / 100
const limit = val('limit') ? Number(val('limit')) : Infinity
const outFile = val('out', 'precos_minimos.csv')
const semCategoria = args.includes('--sem-categoria')
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
const money = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const OUT_HEADER = ['COD_PRODUTO', 'PRODUTO', 'MARCA', 'CUSTO', 'CATEGORIA_ML', 'COMISSAO_PCT', 'PRECO_EMPATE', `PRECO_${Math.round(margemAlvo * 100)}PCT`, 'OBS']

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

// Comissão real da categoria. Sem categoria, usa a padrão do ML.
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

  let categoryId = '', categoryName = ''
  if (!semCategoria) {
    try {
      const cats = await withRetry(() => predictCategory(nome))
      if (cats[0]) { categoryId = cats[0].category_id; categoryName = cats[0].category_name }
    } catch {}
  }

  const ref = Math.max(custo * 3, 25) // preço de referência só pra ler a % (a % não varia com o preço)
  let pct
  try {
    pct = await withRetry(() => comissaoPct(ref, categoryId))
    if (pct == null && categoryId) pct = await withRetry(() => comissaoPct(ref, '')) // fallback sem categoria
  } catch (e) {
    return { ...base, OBS: 'erro comissão: ' + (e.data?.message || e.message || '').slice(0, 80) }
  }
  if (pct == null) return { ...base, OBS: 'sem comissão' }

  const p = pct / 100
  // profit = preço - custo - preço*p ; empate: preço = custo/(1-p)
  const empate = custo / (1 - p)
  const alvo = custo / (1 - p - margemAlvo)

  return {
    ...base,
    CATEGORIA_ML: categoryName ? `${categoryName} (${categoryId})` : (semCategoria ? 'padrão' : ''),
    COMISSAO_PCT: String(pct),
    PRECO_EMPATE: money(empate),
    [`PRECO_${Math.round(margemAlvo * 100)}PCT`]: alvo > 0 ? money(alvo) : 'margem impossível',
    OBS: 'frete e imposto não inclusos',
  }
}

async function main() {
  if (!process.env.ML_CLIENT_ID || !process.env.ML_CLIENT_SECRET) {
    console.error('\n❌ Faltam ML_CLIENT_ID e ML_CLIENT_SECRET no .env\n'); process.exit(1)
  }
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
  console.log(`\n▶  ${total} produtos · margem alvo ${Math.round(margemAlvo * 100)}% · ${semCategoria ? 'comissão padrão' : 'categoria detectada'}\n`)

  let idx = 0, ok = 0, err = 0
  async function worker() {
    while (idx < pending.length) {
      const my = idx++
      const res = await processar(pending[my])
      fs.appendFileSync(outputPath, OUT_HEADER.map((h) => csvCell(res[h])).join(';') + '\n')
      if (res.PRECO_EMPATE) ok++; else err++
      const n = my + 1
      if (n % 10 === 0 || n === total) process.stdout.write(`  ${n}/${total}  ok:${ok} s/preço:${err}\r`)
      await sleep(120)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, total || 1) }, worker))
  console.log(`\n\n✅ Salvo em ${outFile} — ${ok} com preço calculado, ${err} sem.\n`)
}

main().catch((e) => { console.error('\n❌', e.message); process.exit(1) })

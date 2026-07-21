import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { findWinner } from '../server/catalog.js'
import { getFees } from '../server/ml.js'

// ---------------------------------------------------------------------------
// Uso:
//   node scripts/batch.js [arquivo.csv] [opções]
//
// Opções:
//   --limit N     processa só os N primeiros (ótimo para testar)
//   --out FILE    arquivo de saída (padrão: analise_taxas_reais.csv)
//   --ativos      (só prod.csv) processa apenas ATIVO = S
//   --freight     tenta também estimar o frete real (mais lento, +1 chamada/produto)
//   --conc N      quantos produtos em paralelo (padrão 4)
//
// Exemplos:
//   node scripts/batch.js estoq.csv --limit 20
//   node scripts/batch.js estoq.csv --out taxas.csv --freight
//
// Pré-requisito: ter logado uma vez pelo app (npm run dev -> Entrar com o ML),
// pois este script reaproveita o token salvo em .tokens.json.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const opt = (name, def = null) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[i + 1]) : def
}
const inputFile = args.find((a) => !a.startsWith('--')) || 'estoq.csv'
const outFile = opt('out', 'analise_taxas_reais.csv')
const limit = opt('limit') ? Number(opt('limit')) : Infinity
const somenteAtivos = args.includes('--ativos')
const comFrete = args.includes('--freight')
const CONC = opt('conc') ? Number(opt('conc')) : 4

const ROOT = path.resolve(process.cwd())
const inputPath = path.resolve(ROOT, inputFile)
const outputPath = path.resolve(ROOT, outFile)

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseCusto(raw) {
  if (!raw) return 0
  const s = String(raw).replace(/r\$/i, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function readCsvLatin1(file) {
  const buf = fs.readFileSync(file)
  const text = new TextDecoder('windows-1252').decode(buf)
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const header = lines[0].split(';').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cols = line.split(';')
    const row = {}
    header.forEach((h, i) => (row[h] = (cols[i] ?? '').trim()))
    return row
  })
}

const OUT_HEADER = [
  'COD_PRODUTO', 'PRODUTO', 'MARCA', 'CUSTO',
  'ENCONTROU', 'CATALOGO_ML', 'CATEGORIA', 'PRECO_CONCORRENTE',
  'COMISSAO_PCT', 'COMISSAO_RS', 'CUSTO_FIXO_RS', 'FRETE_RS',
  'SOBRA_RS', 'SOBRA_PCT', 'VEREDITO', 'OBS',
]

function classify(sobraPct, matched) {
  if (!matched) return 'sem anúncio no ML'
  if (sobraPct >= 12) return 'dá pra competir'
  if (sobraPct >= 0) return 'apertado'
  return 'não fecha'
}

// ---------- pipeline por produto ----------
async function withRetry(fn, tries = 4) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const status = e.status || 0
      if (status === 429 || status >= 500) {
        await sleep(800 * Math.pow(2, i)) // backoff: 0.8s, 1.6s, 3.2s...
        continue
      }
      throw e
    }
  }
  throw lastErr
}

async function processar(row) {
  const cod = row.COD_PRODUTO
  const nome = row.PRODUTO || ''
  const marca = row.MARCA || ''
  const custo = parseCusto(row.ULTIMO_CUSTO)

  const base = { COD_PRODUTO: cod, PRODUTO: nome, MARCA: marca, CUSTO: custo.toFixed(2) }

  let winner
  try {
    winner = await withRetry(() => findWinner(nome))
  } catch (e) {
    return { ...base, ENCONTROU: 'erro', OBS: (e.data?.message || e.message || '').slice(0, 120), VEREDITO: 'erro' }
  }

  if (!winner.matched) {
    const obs = winner.reason === 'catalogo_sem_preco'
      ? 'existe no catálogo, mas sem vendedor ativo (sem preço)'
      : 'não achei no catálogo do ML'
    return {
      ...base,
      ENCONTROU: 'não',
      CATALOGO_ML: winner.catalog_id || '',
      VEREDITO: 'sem preço no ML',
      OBS: obs,
    }
  }

  const price = Number(winner.price)
  let fees
  try {
    fees = await withRetry(() =>
      getFees({
        price,
        listing_type: 'gold_special',
        logistic_type: winner.logistic_type || 'cross_docking',
        category_id: winner.category_id || '',
        free_shipping: winner.free_shipping === false ? 'false' : 'true',
        // sem dimensões aqui; frete só se --freight (tratado abaixo)
      })
    )
  } catch (e) {
    return {
      ...base, ENCONTROU: 'sim', CATALOGO_ML: winner.catalog_id, CATEGORIA: winner.category_id,
      PRECO_CONCORRENTE: price.toFixed(2), VEREDITO: 'erro',
      OBS: 'listing_prices: ' + (e.data?.message || e.message || '').slice(0, 100),
    }
  }

  const comissao = Number(fees.commission_total) || 0
  const custoFixo = Number(fees.fixed_fee) || 0
  const frete = comFrete && fees.freight != null ? Number(fees.freight) : null
  const sobra = price - custo - comissao - (frete || 0)
  const sobraPct = price > 0 ? (sobra / price) * 100 : 0

  return {
    ...base,
    ENCONTROU: 'sim',
    CATALOGO_ML: winner.catalog_id,
    CATEGORIA: winner.category_id || '',
    PRECO_CONCORRENTE: price.toFixed(2),
    COMISSAO_PCT: fees.percentage_fee != null ? String(fees.percentage_fee) : '',
    COMISSAO_RS: comissao.toFixed(2),
    CUSTO_FIXO_RS: custoFixo.toFixed(2),
    FRETE_RS: frete != null ? frete.toFixed(2) : (comFrete ? 's/ medidas' : ''),
    SOBRA_RS: sobra.toFixed(2),
    SOBRA_PCT: sobraPct.toFixed(1),
    VEREDITO: classify(sobraPct, true),
    OBS: comFrete ? '' : 'frete não incluso',
  }
}

// ---------- runner com concorrência + resume ----------
async function main() {
  if (!process.env.ML_CLIENT_ID || !process.env.ML_CLIENT_SECRET) {
    console.error('\n❌ Faltam credenciais. Preencha ML_CLIENT_ID e ML_CLIENT_SECRET no arquivo .env e rode de novo.\n')
    process.exit(1)
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`\n❌ Não achei o arquivo: ${inputPath}\n`)
    process.exit(1)
  }

  let rows = readCsvLatin1(inputPath)
  if (somenteAtivos) rows = rows.filter((r) => (r.ATIVO || '').toUpperCase() === 'S')

  // resume: pula quem já está no arquivo de saída
  const done = new Set()
  if (fs.existsSync(outputPath)) {
    const prev = fs.readFileSync(outputPath, 'utf8').split(/\r?\n/).slice(1)
    for (const l of prev) {
      const c = l.split(';')[0]?.replace(/^"|"$/g, '')
      if (c) done.add(c)
    }
    console.log(`↩  Retomando: ${done.size} produtos já processados serão pulados.`)
  } else {
    fs.writeFileSync(outputPath, '﻿' + OUT_HEADER.join(';') + '\n') // BOM para o Excel PT-BR
  }

  let pending = rows.filter((r) => r.COD_PRODUTO && !done.has(r.COD_PRODUTO))
  if (Number.isFinite(limit)) pending = pending.slice(0, limit)

  const total = pending.length
  console.log(`\n▶  Processando ${total} produtos de ${inputFile} (concorrência ${CONC}${comFrete ? ', com frete' : ''})…\n`)

  let idx = 0
  let ok = 0, semAnuncio = 0, erro = 0
  const stats = { 'dá pra competir': 0, apertado: 0, 'não fecha': 0 }

  async function worker() {
    while (idx < pending.length) {
      const my = idx++
      const row = pending[my]
      const res = await processar(row)
      fs.appendFileSync(outputPath, OUT_HEADER.map((h) => csvCell(res[h])).join(';') + '\n')

      if (res.VEREDITO === 'erro') erro++
      else if (res.ENCONTROU === 'não') semAnuncio++
      else { ok++; if (stats[res.VEREDITO] != null) stats[res.VEREDITO]++ }

      const n = my + 1
      if (n % 10 === 0 || n === total) {
        process.stdout.write(`  ${n}/${total}  ✓${ok} competir:${stats['dá pra competir']} apertado:${stats.apertado} nãofecha:${stats['não fecha']} s/anúncio:${semAnuncio} erro:${erro}\r`)
      }
      await sleep(120) // respiro entre chamadas para não bater no rate limit
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONC, total || 1) }, worker))

  console.log(`\n\n✅ Pronto! Resultado salvo em: ${outFile}`)
  console.log(`   ${ok} com anúncio · ${semAnuncio} sem anúncio · ${erro} com erro`)
  console.log(`   dá pra competir: ${stats['dá pra competir']} · apertado: ${stats.apertado} · não fecha: ${stats['não fecha']}\n`)
}

main().catch((e) => {
  console.error('\n❌ Erro geral:', e.message)
  process.exit(1)
})

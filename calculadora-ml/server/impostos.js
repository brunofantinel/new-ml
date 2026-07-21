import fs from 'node:fs'
import path from 'node:path'

// Mapa de ICMS/ST por produto, extraido das NF-e de entrada do ERP (AUTOCOM).
// Gerado por ../../impostos/extrair_impostos.py -> impostos_app.json.
// Carregado uma unica vez em memoria (lazy) e consultado por GTIN ou codigo.

let MAPA = null // { _meta, por_gtin, por_cod }
let NCM = null  // { _meta, por_ncm }

function lerJson(nome, fallback) {
  const candidatos = [
    path.resolve(process.cwd(), 'dist', nome),
    path.resolve(process.cwd(), 'public', nome),
  ]
  for (const p of candidatos) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch {
      /* tenta o proximo */
    }
  }
  return fallback
}

function carregar() {
  if (!MAPA) MAPA = lerJson('impostos_app.json', { _meta: { ausente: true }, por_gtin: {}, por_cod: {} })
  return MAPA
}
function carregarNcm() {
  if (!NCM) NCM = lerJson('impostos_ncm.json', { _meta: { ausente: true }, por_ncm: {} })
  return NCM
}

// so digitos (o usuario pode digitar com espacos/traco no codigo de barras)
const soDigitos = (s) => String(s || '').replace(/\D/g, '')

// Consulta um produto. Aceita GTIN (codigo de barras) ou o codigo interno.
// Retorna { encontrado, chave, st, icms, ncm, descr } ou { encontrado:false }.
export function lookupImposto(termo) {
  const mapa = carregar()
  if (mapa._meta?.ausente) return { encontrado: false, erro: 'mapa_ausente' }

  const bruto = String(termo || '').trim()
  const dig = soDigitos(bruto)

  // 1) tenta como GTIN (codigo de barras)
  let r = dig && mapa.por_gtin[dig]
  let chave = 'gtin'
  // 2) senao, tenta como codigo interno do produto
  if (!r && dig) { r = mapa.por_cod[dig]; chave = 'cod' }

  if (r) {
    return {
      encontrado: true,
      por: chave,
      st: !!r.st,
      icms: Number(r.icms) || 0, // % ICMS interno configurado (info)
      ic: Number(r.ic) || 0,     // % ICMS destacado na compra = credito
      ncm: r.ncm || '',
      descr: r.d || '',
    }
  }

  // 3) senao, tenta como NCM (8 digitos) -> agregado do proprio historico
  if (dig.length === 8) {
    const g = carregarNcm().por_ncm[dig]
    if (g) {
      return {
        encontrado: true,
        por: 'ncm',
        st: !!g.st,
        icms: 0,
        ic: Number(g.ic) || 0,
        ncm: dig,
        share: Number(g.share) || 0, // fracao de produtos ST nesse NCM
        n: Number(g.n) || 0,         // quantos produtos sustentam a estatistica
        descr: `NCM ${dig} — baseado em ${g.n} produto(s) da sua base`,
      }
    }
  }

  return { encontrado: false }
}

export function impostosMeta() {
  return carregar()._meta || {}
}

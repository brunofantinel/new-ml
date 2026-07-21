import fs from 'node:fs'
import path from 'node:path'

// Mapa de ICMS/ST por produto, extraido das NF-e de entrada do ERP (AUTOCOM).
// Gerado por ../../impostos/extrair_impostos.py -> impostos_app.json.
// Carregado uma unica vez em memoria (lazy) e consultado por GTIN ou codigo.

let MAPA = null // { _meta, por_gtin, por_cod }

function carregar() {
  if (MAPA) return MAPA
  const candidatos = [
    path.resolve(process.cwd(), 'dist', 'impostos_app.json'),
    path.resolve(process.cwd(), 'public', 'impostos_app.json'),
  ]
  for (const p of candidatos) {
    try {
      if (fs.existsSync(p)) {
        MAPA = JSON.parse(fs.readFileSync(p, 'utf-8'))
        return MAPA
      }
    } catch {
      /* tenta o proximo */
    }
  }
  MAPA = { _meta: { ausente: true }, por_gtin: {}, por_cod: {} }
  return MAPA
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

  if (!r) return { encontrado: false }
  return {
    encontrado: true,
    por: chave,
    st: !!r.st,
    icms: Number(r.icms) || 0, // % de ICMS na revenda (0 se ST)
    ncm: r.ncm || '',
    descr: r.d || '',
  }
}

export function impostosMeta() {
  return carregar()._meta || {}
}

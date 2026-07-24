import { db } from './db.js'
import { mlGet } from './ml.js'
import { validarAnuncio, publicarAnuncio } from './publicar.js'

// ===========================================================================
// Fila de REVISÃO de anúncios (aprovação do gestor).
//
// Em vez de publicar direto, o wizard "Publicar anúncio" enfileira aqui com
// status 'pendente'. Na aba "Revisor", o gestor vê tudo como será publicado
// (com custo, valor de venda e média dos anúncios do ML bem destacados), pode
// ajustar SÓ o preço final e então APROVAR (publica de verdade) ou REPROVAR.
// ===========================================================================

const agora = () => new Date().toISOString()
const erro = (msg, status) => Object.assign(new Error(msg), { status })

// ---------------------------------------------------------------------------
// Média aritmética dos preços de TODOS os vendedores ativos do produto de
// catálogo. (getCatalogLive em ml.js só devolve o MENOR preço; esta é nova.)
// Best-effort: devolve { media: null, n: 0 } quando não há id ou dá erro.
// ---------------------------------------------------------------------------
export async function mediaAnuncios(catalogId) {
  if (!catalogId) return { media: null, n: 0 }
  const r = await mlGet(`/products/${catalogId}/items`)
  const precos = (Array.isArray(r?.results) ? r.results : [])
    .map((it) => it?.price)
    .filter((p) => typeof p === 'number' && p > 0)
  if (!precos.length) return { media: null, n: 0 }
  return { media: precos.reduce((a, b) => a + b, 0) / precos.length, n: precos.length }
}

// ---------------------------------------------------------------------------
// Enfileira uma revisão. body = payloadRevisao() do wizard (payload() + custo,
// cod_erp, category_attributes, category_path).
// ---------------------------------------------------------------------------
export async function criarRevisao(body = {}) {
  const titulo = String(body.title || '').trim()
  const preco = Number(body.price)
  if (!titulo) throw erro('faltou_titulo', 400)
  if (!(preco > 0)) throw erro('preco_invalido', 400)

  const pics = Array.isArray(body.pictures) ? body.pictures : []
  const thumb = pics[0]?.url || pics[0]?.source || null
  const custo = body.custo != null && body.custo !== '' ? Number(body.custo) : null
  const codErp = body.cod_erp ? String(body.cod_erp) : null

  // snapshot da média (não trava o envio se o ML estiver fora)
  const m = await mediaAnuncios(body.catalog_id).catch(() => ({ media: null, n: 0 }))

  const ts = agora()
  const info = db.prepare(`
    INSERT INTO revisoes
      (status, payload, titulo, preco, custo, cod_erp, thumb, media_ml, media_ml_n, criado_em, atualizado_em)
    VALUES ('pendente', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify(body), titulo, preco,
    custo, codErp, thumb,
    m.media, m.n, ts, ts,
  )
  return { id: Number(info.lastInsertRowid), status: 'pendente' }
}

// ---------------------------------------------------------------------------
// Lista as revisões (resumo, sem o payload). Filtra por status quando informado.
// Sempre devolve a contagem de pendentes (pro badge da aba).
// ---------------------------------------------------------------------------
export function listarRevisoes(status) {
  const s = String(status || '').trim()
  const rows = s
    ? db.prepare(`SELECT id, status, titulo, preco, custo, thumb, media_ml, media_ml_n, resultado, motivo, criado_em, atualizado_em
                    FROM revisoes WHERE status = ? ORDER BY id DESC`).all(s)
    : db.prepare(`SELECT id, status, titulo, preco, custo, thumb, media_ml, media_ml_n, resultado, motivo, criado_em, atualizado_em
                    FROM revisoes ORDER BY id DESC`).all()

  const revisoes = rows.map((r) => {
    const res = r.resultado ? safeParse(r.resultado) : null
    return {
      id: r.id,
      status: r.status,
      titulo: r.titulo,
      preco: r.preco,
      custo: r.custo,
      thumb: r.thumb,
      media_ml: r.media_ml,
      media_ml_n: r.media_ml_n,
      item_id: res?.item_id || null,
      permalink: res?.permalink || null,
      motivo: r.motivo || null,
      criado_em: r.criado_em,
      atualizado_em: r.atualizado_em,
    }
  })
  const pendentes = db.prepare(`SELECT COUNT(*) AS n FROM revisoes WHERE status = 'pendente'`).get().n
  return { revisoes, pendentes }
}

// ---------------------------------------------------------------------------
// Detalhe de uma revisão. Recalcula a média do ML AO VIVO (e atualiza o
// snapshot); se falhar, cai pro snapshot gravado no envio.
// ---------------------------------------------------------------------------
export async function obterRevisao(id) {
  const row = db.prepare(`SELECT * FROM revisoes WHERE id = ?`).get(id)
  if (!row) throw erro('revisao_nao_encontrada', 404)

  const payload = safeParse(row.payload) || {}
  let media_ml = { valor: row.media_ml ?? null, n: row.media_ml_n ?? 0, fonte: 'snapshot' }
  try {
    const m = await mediaAnuncios(payload.catalog_id)
    if (m.media != null) {
      media_ml = { valor: m.media, n: m.n, fonte: 'live' }
      db.prepare(`UPDATE revisoes SET media_ml = ?, media_ml_n = ? WHERE id = ?`).run(m.media, m.n, id)
    }
  } catch { /* mantém o snapshot */ }

  return {
    id: row.id,
    status: row.status,
    payload,
    custo: row.custo,
    cod_erp: row.cod_erp,
    preco: row.preco,
    thumb: row.thumb,
    media_ml,
    resultado: row.resultado ? safeParse(row.resultado) : null,
    motivo: row.motivo || null,
    criado_em: row.criado_em,
    atualizado_em: row.atualizado_em,
  }
}

// ---------------------------------------------------------------------------
// Aprovar e publicar: sobrescreve o preço com o preço final editado, revalida
// no ML e publica de verdade. Se a validação falhar, NÃO muda o status (o
// gestor corrige o preço e tenta de novo).
// ---------------------------------------------------------------------------
export async function publicarRevisao(id, { price } = {}) {
  const row = db.prepare(`SELECT * FROM revisoes WHERE id = ?`).get(id)
  if (!row) throw erro('revisao_nao_encontrada', 404)
  if (row.status !== 'pendente') throw erro('ja_processada', 409)

  const preco = Number(price)
  if (!(preco > 0)) throw erro('preco_invalido', 400)

  const payload = safeParse(row.payload) || {}
  payload.price = preco

  const val = await validarAnuncio(payload)
  if (!val.ok) return { ok: false, erros: val.erros }

  const resultado = await publicarAnuncio(payload)
  db.prepare(`UPDATE revisoes SET status = 'publicado', preco = ?, payload = ?, resultado = ?, atualizado_em = ? WHERE id = ?`)
    .run(preco, JSON.stringify(payload), JSON.stringify(resultado), agora(), id)
  return { ok: true, resultado }
}

// ---------------------------------------------------------------------------
// Reprovar: marca como reprovado com um motivo opcional.
// ---------------------------------------------------------------------------
export function reprovarRevisao(id, { motivo } = {}) {
  const row = db.prepare(`SELECT status FROM revisoes WHERE id = ?`).get(id)
  if (!row) throw erro('revisao_nao_encontrada', 404)
  if (row.status !== 'pendente') throw erro('ja_processada', 409)

  db.prepare(`UPDATE revisoes SET status = 'reprovado', motivo = ?, atualizado_em = ? WHERE id = ?`)
    .run(motivo ? String(motivo) : null, agora(), id)
  return { ok: true, status: 'reprovado' }
}

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

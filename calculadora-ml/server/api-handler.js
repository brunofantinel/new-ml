import { authStatus, getFees, buildAuthUrl, exchangeCode, getCatalogLive, getTendenciaVisitas, mlUploadPicture, getMeusAnuncios, acaoAnuncio } from './ml.js'
import { findCompetitor, suggestCategories, getAnuncioBase, buscarCategorias, getPacoteAnuncio } from './catalog.js'
import { pesquisarMercado, buscarAnuncios } from './mercado.js'
import { consultarProdutoErp, consultarPorBarras, erpStatus } from './erp.js'
import { getEmAlta, categoriasRaiz, categoriasFilhas, termosDoSite, demanda } from './alta.js'
import { lerRelatorio, lerProdutos, analisarCategoria, pontuar } from './categorias.js'
import { buscarCatalogo, prefillAnuncio, feesPorTipo, validarAnuncio, publicarAnuncio } from './publicar.js'

// Handler compartilhado das rotas /api/* e /callback.
// Usado tanto pelo dev-server do Vite (vite-plugin-api.js) quanto pelo
// servidor de produção (server.js). Retorna true se tratou a requisição.
export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  if (path !== '/callback' && !path.startsWith('/api/')) return false

  try {
    if (path === '/api/auth/login') {
      res.statusCode = 302
      res.setHeader('Location', buildAuthUrl())
      res.end()
      return true
    }
    if (path === '/callback') {
      const code = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      if (err) { html(res, `<h2>Erro do Mercado Livre: ${err}</h2><p>${url.searchParams.get('error_description') || ''}</p><a href="/">voltar</a>`); return true }
      if (!code) { html(res, '<h2>Faltou o code na volta do ML.</h2><a href="/">voltar</a>'); return true }
      await exchangeCode(code)
      html(res, '<h2>✅ Vendedor conectado!</h2><p>Pode fechar esta aba e voltar para o app.</p><a href="/">abrir o app</a>')
      return true
    }
    if (path === '/api/auth/status') { json(res, authStatus()); return true }
    if (path === '/api/predict-category') { json(res, await suggestCategories(url.searchParams.get('q') || '')); return true }
    if (path === '/api/competitor') { json(res, await findCompetitor(url.searchParams.get('q') || '')); return true }
    // busca de CATEGORIA por nome (ex: "eletronicos") — diferente de
    // /api/predict-category, que parte de um produto
    if (path === '/api/buscar-categoria') { json(res, await buscarCategorias(url.searchParams.get('q') || '')); return true }
    if (path === '/api/anuncio') { json(res, await getAnuncioBase(url.searchParams.get('catalog_id') || '', url.searchParams.get('category_id') || '')); return true }
    // ── O que está em alta no ML (caminho inverso: parte do mercado) ──
    if (path === '/api/categorias') {
      const pai = (url.searchParams.get('pai') || '').trim()
      json(res, pai ? await categoriasFilhas(pai) : { filhas: await categoriasRaiz() })
      return true
    }
    if (path === '/api/em-alta') {
      json(res, await getEmAlta(
        url.searchParams.get('categoria') || '',
        Number(url.searchParams.get('dias')) || 0,
      ))
      return true
    }
    if (path === '/api/termos-alta') { json(res, await termosDoSite()); return true }
    // relatório de categorias (gerado pelo job scripts/categorias-alta.mjs)
    if (path === '/api/categorias-alta') {
      const r = lerRelatorio()
      if (!r) {
        json(res, { vazio: true, comando: 'npm run categorias' })
      } else {
        json(res, r)
      }
      return true
    }
    // produtos que estão subindo, de todas as categorias varridas
    if (path === '/api/produtos-em-alta') {
      const r = lerProdutos()
      json(res, r || { vazio: true, comando: 'npm run categorias' })
      return true
    }
    // recalcula UMA categoria na hora (botão "atualizar" da tela)
    if (path === '/api/categoria-agora') {
      const id = (url.searchParams.get('id') || '').trim()
      if (!id) { res.statusCode = 400; json(res, { erro: 'faltou id' }); return true }
      const c = await analisarCategoria(id, {
        dias: Number(url.searchParams.get('dias')) || 30,
        top: Number(url.searchParams.get('top')) || 12,
      })
      const ref = { maxPorOferta: Number(url.searchParams.get('ref')) || 1 }
      json(res, c ? pontuar(c, ref) : { erro: 'nao_analisada' })
      return true
    }
    // série diária de visitas de UM produto — usado quando a pessoa troca a
    // janela do gráfico dentro do card, sem recarregar a categoria inteira
    if (path === '/api/serie-visitas') {
      const ids = (url.searchParams.get('itens') || '').split(',').map((s) => s.trim()).filter(Boolean)
      json(res, (await demanda(ids, Number(url.searchParams.get('dias')) || 30)) || { erro: 'sem_dados' })
      return true
    }

    // peso e medidas da embalagem, lidos dos anúncios reais desse produto
    if (path === '/api/pacote') {
      json(res, await getPacoteAnuncio(
        (url.searchParams.get('catalog_id') || '').trim(),
        (url.searchParams.get('item_id') || '').trim(),
      ))
      return true
    }
    if (path === '/api/fees') { json(res, await getFees(Object.fromEntries(url.searchParams))); return true }
    if (path === '/api/mercado') { json(res, await pesquisarMercado(url.searchParams.get('q') || '')); return true }
    if (path === '/api/anuncios') {
      json(res, await buscarAnuncios({
        gtin: url.searchParams.get('gtin') || '',
        gtin_nf: url.searchParams.get('gtin_nf') || '',
        ref: url.searchParams.get('ref') || '',
        nome: url.searchParams.get('nome') || '',
      }))
      return true
    }
    if (path === '/api/produto') { json(res, await consultarProdutoErp(url.searchParams.get('cod') || '')); return true }
    if (path === '/api/produto-barras') { json(res, await consultarPorBarras(url.searchParams.get('barras') || '')); return true }
    if (path === '/api/tendencia') { json(res, await getTendenciaVisitas(url.searchParams.get('ids') || '', Number(url.searchParams.get('dias')) || 60)); return true }
    if (path === '/api/erp/status') { json(res, await erpStatus()); return true }
    if (path === '/api/vantagem/live') {
      const catalogId = (url.searchParams.get('catalog_id') || '').trim()
      const custo = Number(url.searchParams.get('custo') || 0)
      // frete estimado guardado da análise (peso não é conhecido ao vivo)
      const freteBase = Number(url.searchParams.get('frete') || 0)
      if (!catalogId) { res.statusCode = 400; json(res, { error: 'faltou catalog_id' }); return true }
      const live = await getCatalogLive(catalogId)
      let comissao = null
      if (live.price != null) {
        const fees = await getFees({
          price: String(live.price),
          category_id: live.category_id || '',
          logistic_type: live.logistic_type || 'cross_docking',
        })
        // commission_total já inclui a comissão % + o custo fixo do ML
        comissao = fees?.commission_total ?? null
      }
      // custo ML total = comissão (atualizada com o preço de agora) + frete estimado
      const custoMl = comissao != null ? comissao + freteBase : null
      const margemRs = live.price != null && custoMl != null ? live.price - custo - custoMl : null
      const margemPct = margemRs != null && live.price ? margemRs / live.price : null
      json(res, {
        catalog_id: catalogId,
        price_now: live.price,
        n_vend: live.n_vend,
        status: live.status,
        item_id: live.item_id,
        category_id: live.category_id,
        comissao,
        frete: freteBase,
        custo_ml: custoMl,
        margem_rs: margemRs,
        margem_pct: margemPct,
      })
      return true
    }

    // ===== Meus anúncios (vendedor) =====
    if (path === '/api/meus-anuncios') {
      json(res, await getMeusAnuncios({
        limit: Number(url.searchParams.get('limit')) || 50,
        offset: Number(url.searchParams.get('offset')) || 0,
      }))
      return true
    }
    if (path === '/api/anuncio/acao') {
      if (req.method !== 'POST') { res.statusCode = 405; json(res, { error: 'metodo_invalido' }); return true }
      const b = await readJson(req)
      json(res, await acaoAnuncio(b.id, b.acao))
      return true
    }

    // ===== Publicar anúncio =====
    if (path === '/api/publicar/busca') { json(res, await buscarCatalogo(url.searchParams.get('q') || '')); return true }
    if (path === '/api/publicar/prefill') { json(res, await prefillAnuncio(url.searchParams.get('catalog_id') || '')); return true }
    if (path === '/api/publicar/fees') {
      json(res, await feesPorTipo({
        price: url.searchParams.get('price') || '0',
        category_id: url.searchParams.get('category_id') || '',
        logistic_type: url.searchParams.get('logistic_type') || 'cross_docking',
        weight_grams: url.searchParams.get('weight_grams') || '',
        dimensions: url.searchParams.get('dimensions') || '',
        free_shipping: url.searchParams.get('free_shipping'),
      }))
      return true
    }
    if (path === '/api/publicar/foto') {
      if (req.method !== 'POST') { res.statusCode = 405; json(res, { error: 'metodo_invalido' }); return true }
      const buf = await readBody(req)
      const filename = decodeURIComponent(req.headers['x-filename'] || 'foto.jpg')
      const mime = req.headers['content-type'] || 'image/jpeg'
      const pic = await mlUploadPicture(buf, filename, mime)
      const url0 = pic?.variations?.[0]?.secure_url || pic?.variations?.[0]?.url || null
      json(res, { id: pic?.id || null, url: url0 })
      return true
    }
    if (path === '/api/publicar/validar') {
      if (req.method !== 'POST') { res.statusCode = 405; json(res, { error: 'metodo_invalido' }); return true }
      json(res, await validarAnuncio(await readJson(req)))
      return true
    }
    if (path === '/api/publicar/publicar') {
      if (req.method !== 'POST') { res.statusCode = 405; json(res, { error: 'metodo_invalido' }); return true }
      json(res, await publicarAnuncio(await readJson(req)))
      return true
    }

    return false
  } catch (e) {
    res.statusCode = e.status || 500
    json(res, { error: e.message, detail: e.data || null })
    return true
  }
}

function json(res, obj) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}
function html(res, body) {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem;max-width:40rem;margin:auto">${body}</body>`)
}

// Lê o corpo bruto da requisição (binário). Usado pelo upload de foto (arquivo
// puro) e como base do readJson. Aborta se passar do limite pra não estourar RAM.
function readBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); reject(Object.assign(new Error('arquivo_muito_grande'), { status: 413 })) ; return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024)
  try { return JSON.parse(buf.toString('utf8') || '{}') }
  catch { throw Object.assign(new Error('json_invalido'), { status: 400 }) }
}

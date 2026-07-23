import { authStatus, getFees, buildAuthUrl, exchangeCode, getCatalogLive, getTendenciaVisitas } from './ml.js'
import { findCompetitor, suggestCategories, getAnuncioBase, buscarCategorias, getPacoteAnuncio } from './catalog.js'
import { pesquisarMercado, buscarAnuncios } from './mercado.js'
import { consultarProdutoErp, consultarPorBarras, erpStatus } from './erp.js'

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

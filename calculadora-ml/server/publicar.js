import { mlGet, mlPost, getFees } from './ml.js'
import { limparNome } from './catalog.js'

// ===========================================================================
// Fluxo de PUBLICAÇÃO de anúncios (primeira operação de escrita do projeto).
//
// A ideia é seguir as "melhores práticas" de qualidade do Mercado Livre:
//  - dados vêm do CATÁLOGO do ML (título, fotos e ficha técnica já padronizados);
//  - a ficha técnica é preenchida ao máximo (atributos obrigatórios da categoria);
//  - garantia e descrição definidas;
//  - o anúncio é VALIDADO (dry-run) antes de publicar de verdade.
//
// Obs.: o ML está migrando o fluxo de publicação de catálogo para "User Products".
// Enquanto isso, o POST /items com catalog_product_id + catalog_listing continua
// funcionando no site MLB. Se um dia parar, é aqui que muda.
// ===========================================================================

// ---------------------------------------------------------------------------
// Passo 1 — buscar produtos no catálogo do ML pelo nome/termo.
// Reusa a mesma base de catalog.js (/products/search) e devolve o essencial pra
// o usuário reconhecer e escolher o produto certo.
// ---------------------------------------------------------------------------
export async function buscarCatalogo(query) {
  const q = limparNome(query) || query
  if (!q) return { results: [] }
  let raw = []
  try {
    const r = await mlGet(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}`)
    raw = Array.isArray(r?.results) ? r.results.slice(0, 8) : []
  } catch {
    return { results: [] }
  }
  const results = raw.map((p) => ({
    id: p.id,
    name: p.name,
    domain_id: p.domain_id || null,
    thumbnail: pickThumb(p),
    category_id: p.category_id || null,
  }))
  return { results }
}

function pickThumb(p) {
  const pics = Array.isArray(p?.pictures) ? p.pictures : []
  return pics[0]?.url || pics[0]?.secure_url || p?.thumbnail || null
}

// ---------------------------------------------------------------------------
// Passo 2 — montar o pré-preenchimento do anúncio a partir do produto de catálogo.
// Traz título, fotos e atributos já preenchidos pelo ML, MAIS a lista completa
// dos atributos da categoria (com obrigatoriedade e valores permitidos) pra o
// editor de ficha técnica na tela.
// ---------------------------------------------------------------------------
export async function prefillAnuncio(catalogId) {
  if (!catalogId) throw Object.assign(new Error('faltou_catalog_id'), { status: 400 })

  const prod = await mlGet(`/products/${catalogId}`)
  // categoria: o vencedor da buy box costuma ter a categoria "de verdade";
  // se não houver, usa a do próprio produto (mesmo fallback do findWinner).
  const categoryId = prod?.buy_box_winner?.category_id || prod?.category_id || null

  const pictures = (Array.isArray(prod?.pictures) ? prod.pictures : [])
    .map((x) => x.url || x.secure_url)
    .filter(Boolean)
    .map((url) => ({ source: url, url }))

  // atributos já preenchidos no catálogo (id -> value_name)
  const filled = {}
  for (const a of Array.isArray(prod?.attributes) ? prod.attributes : []) {
    if (a?.id && a?.value_name) filled[a.id] = a.value_name
  }

  let categoryAttributes = []
  let categoryPath = null
  if (categoryId) {
    try {
      const at = await mlGet(`/categories/${categoryId}/attributes`)
      categoryAttributes = (Array.isArray(at) ? at : [])
        .filter((a) => !isReadOnly(a))
        .map((a) => ({
          id: a.id,
          name: a.name || a.id,
          value_type: a.value_type || 'string',
          required: !!(a.tags && (a.tags.required || a.tags.catalog_required)),
          allow_custom_value: a.allow_custom_value !== false,
          // lista de valores permitidos (pra virar um <select> na tela)
          values: (Array.isArray(a.values) ? a.values : [])
            .map((v) => ({ id: v.id, name: v.name }))
            .filter((v) => v.name),
          hint: a.hint || null,
          unit: a.default_unit || null,
        }))
    } catch { categoryAttributes = [] }
    try {
      const c = await mlGet(`/categories/${categoryId}`)
      const path = Array.isArray(c?.path_from_root) ? c.path_from_root.map((p) => p.name) : []
      categoryPath = path.join(' > ') || null
    } catch { /* opcional */ }
  }

  return {
    catalog_id: catalogId,
    title: prod?.name || '',
    category_id: categoryId,
    category_path: categoryPath,
    domain_id: prod?.domain_id || null,
    pictures,
    attributes: filled,               // id -> value_name já vindo do catálogo
    category_attributes: categoryAttributes,
    suggested_condition: 'new',
    permalink: catalogId ? `https://www.mercadolivre.com.br/p/${catalogId}` : null,
  }
}

// Atributos que o ML preenche sozinho / não aceita no POST — não mostrar no editor.
function isReadOnly(a) {
  const tags = a?.tags || {}
  return !!(tags.read_only || tags.hidden || tags.variation_attribute || tags.fixed)
}

// ---------------------------------------------------------------------------
// Passo 3 — tarifas dos dois tipos de anúncio (Clássico x Premium) de uma vez,
// pra o usuário comparar antes de escolher. Reusa o getFees existente.
// ---------------------------------------------------------------------------
export async function feesPorTipo({ price, category_id, logistic_type }) {
  const base = { price: String(price || 0), category_id: category_id || '', logistic_type: logistic_type || 'cross_docking' }
  const [gold_special, gold_pro] = await Promise.all([
    getFees({ ...base, listing_type: 'gold_special' }).catch((e) => ({ error: e.message })),
    getFees({ ...base, listing_type: 'gold_pro' }).catch((e) => ({ error: e.message })),
  ])
  return { gold_special, gold_pro }
}

// ---------------------------------------------------------------------------
// Monta o corpo do POST /items a partir do estado do wizard.
// Função PURA (sem I/O) — fácil de testar e reaproveitar em validar/publicar.
// ---------------------------------------------------------------------------
export function montarItemBody(d = {}) {
  const pictures = (Array.isArray(d.pictures) ? d.pictures : [])
    .map((p) => (p.id ? { id: p.id } : p.source ? { source: p.source } : null))
    .filter(Boolean)

  // ficha técnica: { id: value } -> [{ id, value_name }] (ignora vazios)
  const attributes = []
  const attrObj = d.attributes || {}
  for (const id of Object.keys(attrObj)) {
    const value = attrObj[id]
    if (value == null || String(value).trim() === '') continue
    attributes.push({ id, value_name: String(value) })
  }
  // condição também é um atributo (item_condition é o novo padrão do ML)
  if (d.condition && !attrObj.ITEM_CONDITION) {
    attributes.push({ id: 'ITEM_CONDITION', value_name: d.condition === 'used' ? 'Usado' : 'Novo' })
  }

  // garantia (sale_terms) — boa prática: sempre definir
  const sale_terms = []
  if (d.warranty?.type_name) {
    sale_terms.push({ id: 'WARRANTY_TYPE', value_name: d.warranty.type_name })
    const dias = Number(d.warranty.time)
    if (d.warranty.type_name !== 'Sem garantia' && dias > 0) {
      sale_terms.push({ id: 'WARRANTY_TIME', value_name: `${dias} dias` })
    }
  }

  const body = {
    title: d.title || undefined,
    category_id: d.category_id || undefined,
    price: Number(d.price) || 0,
    currency_id: 'BRL',
    available_quantity: Number(d.quantity) || 1,
    buying_mode: 'buy_it_now',
    listing_type_id: d.listing_type_id || 'gold_special',
    condition: d.condition || 'new',
    channels: ['marketplace'],           // exclusive_channel foi removido pelo ML
    pictures,
    attributes,
  }
  if (sale_terms.length) body.sale_terms = sale_terms

  // publicação em cima do catálogo do ML (default): o ML usa o título e as fotos
  // padronizados do produto. Pode ser desligado pra anunciar "fora do catálogo".
  if (d.catalog_id && d.catalog_listing !== false) {
    body.catalog_product_id = d.catalog_id
    body.catalog_listing = true
  }

  // frete: me2 com/sem frete grátis (opcional)
  if (d.free_shipping != null) {
    body.shipping = { mode: 'me2', free_shipping: !!d.free_shipping }
  }

  return body
}

// ---------------------------------------------------------------------------
// Validação (dry-run oficial): POST /items/validate — NÃO cria nada.
// Devolve { ok, erros } já com as mensagens traduzidas pra pt-BR.
// ---------------------------------------------------------------------------
export async function validarAnuncio(d) {
  const body = montarItemBody(d)
  try {
    await mlPost('/items/validate', body)
    // 204/sem corpo = tudo certo
    return { ok: true, erros: [] }
  } catch (e) {
    if (e.status && e.data) return { ok: false, erros: normalizarErros(e.data) }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Publicação de verdade: cria o item, envia a descrição e lê o health (qualidade).
// A falha ao enviar a descrição NÃO desfaz o item já criado — vira só um aviso.
// ---------------------------------------------------------------------------
export async function publicarAnuncio(d) {
  const body = montarItemBody(d)
  const item = await mlPost('/items', body)

  let descriptionOk = null
  if (d.description && String(d.description).trim()) {
    try {
      await mlPost(`/items/${item.id}/description`, { plain_text: String(d.description) })
      descriptionOk = true
    } catch { descriptionOk = false }
  }

  let health = null
  try {
    const h = await mlGet(`/items/${item.id}/health`)
    health = typeof h?.health === 'number' ? h.health : (typeof item.health === 'number' ? item.health : null)
  } catch {
    health = typeof item.health === 'number' ? item.health : null
  }

  return {
    item_id: item.id,
    permalink: item.permalink || null,
    status: item.status || null,
    description_ok: descriptionOk,
    health,
    warnings: Array.isArray(item.warnings) ? item.warnings : [],
  }
}

// ---------------------------------------------------------------------------
// Traduz os erros do ML (array em data.cause) para mensagens amigáveis em pt-BR.
// ---------------------------------------------------------------------------
const ERRO_PT = {
  'item.attributes.missing_required': 'Falta preencher um atributo obrigatório da ficha técnica.',
  'item.attributes.value_not_allowed': 'Um valor da ficha técnica não é aceito nessa categoria.',
  'item.price.invalid': 'Preço inválido para essa categoria.',
  'item.price.required': 'Informe o preço do anúncio.',
  'item.pictures.invalid': 'Alguma foto é inválida ou não pôde ser carregada.',
  'item.pictures.required': 'O anúncio precisa de pelo menos uma foto.',
  'item.category_id.invalid': 'A categoria escolhida não é válida.',
  'item.category_id.required': 'Escolha uma categoria para o anúncio.',
  'item.title.invalid': 'O título tem algum problema (revise palavras proibidas).',
  'item.title.max_length_exceeded': 'O título passou do limite de caracteres.',
  'item.title.required': 'Informe o título do anúncio.',
  'item.listing_type_id.invalid': 'Tipo de anúncio inválido.',
  'item.available_quantity.invalid': 'Quantidade inválida.',
  'item.condition.invalid': 'A condição (novo/usado) é inválida para essa categoria.',
  'seller.not_allowed_to_list': 'Sua conta ainda não pode publicar nessa categoria.',
  'user.not.eligible': 'Sua conta não está habilitada para publicar. Verifique o cadastro no Mercado Livre.',
  'forbidden': 'O token da conexão não tem permissão de escrita. Reconecte habilitando a escrita no aplicativo do Mercado Livre.',
}

function normalizarErros(data) {
  const causes = Array.isArray(data?.cause) ? data.cause
    : data?.cause ? [data.cause]
    : data?.message ? [{ code: data.error || '', message: data.message }]
    : []
  if (!causes.length) {
    return [{ code: data?.error || 'erro', message_pt: data?.message || 'O Mercado Livre recusou o anúncio.', campo: null }]
  }
  return causes.map((c) => {
    const code = c.code || c.type || ''
    const ref = c.references && c.references.length ? String(c.references[0]) : null
    let message_pt = ERRO_PT[code]
    if (message_pt && ref && code === 'item.attributes.missing_required') {
      message_pt = `Falta preencher o atributo obrigatório: ${ref}.`
    }
    return {
      code,
      message_pt: message_pt || c.message || 'O Mercado Livre recusou este ponto do anúncio.',
      campo: ref,
    }
  })
}

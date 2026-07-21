import { useEffect, useState } from 'react'

const money = (v) =>
  'R$ ' + (v < 0 ? '-' : '') + Math.abs(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const LISTING_TYPES = [
  { id: 'gold_special', label: 'Clássico' },
  { id: 'gold_pro', label: 'Premium' },
]

const LOGISTIC_TYPES = [
  { id: 'cross_docking', label: 'Coleta' },
  { id: 'xd_drop_off', label: 'Agência (Places)' },
  { id: 'drop_off', label: 'Correios / Drop off' },
  { id: 'fulfillment', label: 'Full' },
  { id: 'self_service', label: 'Flex' },
]

const pct = (v) => (v == null ? '—' : (v < 0 ? '-' : '') + Math.abs(v * 100).toFixed(1) + '%')

// Margem recalculada na tela para SEMPRE fechar: preço concorrente − seu custo − taxas do ML.
// (as colunas mostradas no card são a fonte da conta, então o total sempre bate)
const margemReal = (i) =>
  i.preco_conc != null && i.custo != null && i.custo_ml != null ? i.preco_conc - i.custo - i.custo_ml : null
const margemRealPct = (i) => {
  const m = margemReal(i)
  return m != null && i.preco_conc ? m / i.preco_conc : null
}

const TIER_INFO = {
  competir: { label: 'Pode competir', cls: 'good' },
  conferir: { label: 'Conferir antes', cls: 'warn' },
  apertado: { label: 'Apertado', cls: 'bad' },
}

export default function App() {
  const [view, setView] = useState('calc')
  const [status, setStatus] = useState({ loading: true, ready: false })

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d) => setStatus({ loading: false, ...d }))
      .catch(() => setStatus({ loading: false, ready: false }))
  }, [])

  return (
    <div className="wrap">
      <nav className="tabs">
        <button className={view === 'calc' ? 'tab on' : 'tab'} onClick={() => setView('calc')}>Calculadora</button>
        <button className={view === 'vantagens' ? 'tab on' : 'tab'} onClick={() => setView('vantagens')}>Vantagens no ML</button>
      </nav>

      {view === 'vantagens' ? (
        <Vantagens />
      ) : (
        <>
          <div className="eyebrow">Taxas reais · API oficial do Mercado Livre</div>
          <h1>Quanto sobra pra você, de verdade?</h1>
          <p className="sub">
            Puxa a comissão e o custo fixo direto da API do Mercado Livre — números reais, já com a regra nova de
            custos de março/2026. O frete é uma estimativa (o frete real exige login do vendedor).
          </p>

          {status.loading ? (
            <p className="spin">Iniciando…</p>
          ) : status.ready ? (
            <>
              <div className="callout" style={{ marginTop: 0 }}>
                {status.seller_connected ? (
                  <><b>Vendedor conectado</b> ✓ — o preço de concorrente (buy box) fica disponível.</>
                ) : (
                  <>
                    <b>Preço de concorrente:</b> conecte sua conta de vendedor para tentar liberar o buy box.{' '}
                    <a href="/api/auth/login">Conectar vendedor</a>
                  </>
                )}
              </div>
              <Calculator />
            </>
          ) : (
            <div className="card connect-box">
              <div className="big-ic">⚙️</div>
              <h2 style={{ justifyContent: 'center' }}>Falta configurar as credenciais</h2>
              <p className="sub" style={{ margin: '0 auto' }}>
                Preencha <code>ML_CLIENT_ID</code> e <code>ML_CLIENT_SECRET</code> no arquivo <code>.env</code> e
                reinicie o servidor (<code>npm run dev</code>).
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Vantagens() {
  const [db, setDb] = useState(null)
  const [err, setErr] = useState(null)
  const [q, setQ] = useState('')
  const [tier, setTier] = useState('todos')
  const [grupo, setGrupo] = useState('todos')
  const [sort, setSort] = useState('margem_rs')
  const [limit, setLimit] = useState(50)
  const [live, setLive] = useState({}) // cod -> { loading, data, err }

  useEffect(() => {
    fetch('/vantagens.json')
      .then((r) => r.json())
      .then(setDb)
      .catch(() => setErr('Não consegui carregar os dados de vantagem (vantagens.json).'))
  }, [])

  if (err) return <div className="callout bad"><b>Erro:</b> {err}</div>
  if (!db) return <p className="spin">Carregando análise de vantagem…</p>

  const grupos = [...new Set(db.itens.map((i) => i.grupo).filter(Boolean))].sort()

  let itens = db.itens
  if (tier !== 'todos') itens = itens.filter((i) => i.tier === tier)
  if (grupo !== 'todos') itens = itens.filter((i) => i.grupo === grupo)
  if (q.trim()) {
    const t = q.trim().toLowerCase()
    itens = itens.filter((i) => `${i.produto} ${i.marca} ${i.produto_ml} ${i.cod}`.toLowerCase().includes(t))
  }
  const sortVal = (i) => {
    if (sort === 'margem_rs') return margemReal(i) ?? -1e12
    if (sort === 'margem_pct') return margemRealPct(i) ?? -1e12
    return i[sort] ?? -1e12
  }
  itens = [...itens].sort((a, b) => sortVal(b) - sortVal(a))
  const shown = itens.slice(0, limit)

  // soma da margem (recalculada) dos que podem competir — bate com os cards
  const somaCompetir = db.itens
    .filter((i) => i.tier === 'competir')
    .reduce((s, i) => s + (margemReal(i) ?? 0), 0)

  async function atualizar(item) {
    setLive((s) => ({ ...s, [item.cod]: { loading: true } }))
    try {
      const d = await fetch(`/api/vantagem/live?catalog_id=${encodeURIComponent(item.catalog_id)}&custo=${item.custo}&frete=${item.frete ?? 0}`).then((r) => r.json())
      if (d.error) throw new Error(d.error)
      setLive((s) => ({ ...s, [item.cod]: { loading: false, data: d } }))
    } catch (e) {
      setLive((s) => ({ ...s, [item.cod]: { loading: false, err: e.message } }))
    }
  }

  return (
    <>
      <div className="eyebrow">Análise · seu custo × concorrente × taxas reais</div>
      <h1>Onde você tem vantagem no Mercado Livre</h1>
      <p className="sub">
        Pesquisa de {db.data_pesquisa}. Comparei seu custo com o menor preço do concorrente no catálogo, já
        descontando <b>todas</b> as taxas do ML. Clique em “Atualizar ao vivo” para conferir o preço do concorrente agora.
      </p>

      <div className="tiles">
        <div className="tile good"><b>{db.contagem.competir}</b><span>podem competir</span></div>
        <div className="tile warn"><b>{db.contagem.conferir}</b><span>conferir antes</span></div>
        <div className="tile bad"><b>{db.contagem.apertado}</b><span>apertado / não fecha</span></div>
        <div className="tile"><b>{money(somaCompetir)}</b><span>margem somada (podem competir)</span></div>
      </div>

      <div className="filters card">
        <input placeholder="Buscar produto, marca ou código…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(50) }} />
        <select value={tier} onChange={(e) => { setTier(e.target.value); setLimit(50) }}>
          <option value="todos">Todos os níveis</option>
          <option value="competir">Podem competir</option>
          <option value="conferir">Conferir antes</option>
          <option value="apertado">Apertado / não fecha</option>
        </select>
        <select value={grupo} onChange={(e) => { setGrupo(e.target.value); setLimit(50) }}>
          <option value="todos">Todos os departamentos</option>
          {grupos.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="margem_rs">Ordenar: maior margem R$</option>
          <option value="margem_pct">Ordenar: maior margem %</option>
          <option value="score">Ordenar: melhor score</option>
          <option value="preco_conc">Ordenar: maior preço concorrente</option>
        </select>
      </div>

      <p className="hint">{itens.length} produtos no filtro · mostrando {shown.length}</p>

      <div className="vlist">
        {shown.map((item) => {
          const lv = live[item.cod]
          const ti = TIER_INFO[item.tier] || { label: item.tier, cls: '' }
          return (
            <div className="vcard card" key={item.cod}>
              <div className="vhead">
                <span className={'pill ' + ti.cls}>{ti.label}</span>
                <span className="vgrp">{item.grupo}</span>
                {item.n_vend != null && <span className="vgrp">{item.n_vend} vendedor{item.n_vend === 1 ? '' : 'es'}</span>}
                {item.chance && <span className="vgrp">chance {item.chance.toLowerCase()}</span>}
              </div>
              <div className="vname">{item.produto}</div>
              <div className="vsub">{item.marca}{item.produto_ml ? ` · casou com: ${item.produto_ml}` : ''}</div>

              <div className="vrows">
                <div className="brow"><span className="k">Seu custo</span><span className="v">{money(item.custo)}</span></div>
                <div className="brow"><span className="k">Concorrente + barato</span><span className="v">{money(item.preco_conc)}</span></div>
                <div className="brow"><span className="k">− Taxas do ML</span><span className="v">− {money(item.custo_ml)}</span></div>
                <div className="brow total">
                  <span className="k">Margem se igualar</span>
                  <span className={'v ' + (margemReal(item) >= 0 ? 'pos' : 'neg')}>{money(margemReal(item))} · {pct(margemRealPct(item))}</span>
                </div>
              </div>

              {lv?.data && (
                <div className={'vlive' + (lv.data.margem_rs != null && lv.data.margem_rs < 0 ? ' neg' : '')}>
                  {lv.data.price_now == null ? (
                    <>⚠️ <b>Agora:</b> sem vendedor ativo no catálogo neste momento.</>
                  ) : (
                    <><b>Agora:</b> concorrente {money(lv.data.price_now)} → margem {money(lv.data.margem_rs)} · {pct(lv.data.margem_pct)}</>
                  )}
                </div>
              )}
              {lv?.err && <div className="vlive err">Falha ao atualizar: {lv.err}</div>}

              <div className="vfoot">
                <button className="ghost" disabled={lv?.loading || !item.catalog_id} onClick={() => atualizar(item)}>
                  {lv?.loading ? 'Consultando o ML…' : 'Atualizar ao vivo'}
                </button>
                {item.url_cat && <a className="ghost link" href={item.url_cat} target="_blank" rel="noreferrer">Ver no ML ▸</a>}
              </div>
              {item.nota && <div className="hint vnote">{item.nota}</div>}
            </div>
          )
        })}
      </div>

      {shown.length < itens.length && (
        <button className="primary" style={{ marginTop: 16 }} onClick={() => setLimit((l) => l + 50)}>
          Mostrar mais ({itens.length - shown.length} restantes)
        </button>
      )}

      <footer>
        Margem já descontadas comissão, custo operacional e frete do ML. Ainda fora: embalagem, imposto do seu regime e
        parcelamento. “Atualizar ao vivo” busca o preço do concorrente na hora pela API oficial.
      </footer>
    </>
  )
}

function Calculator() {
  const [f, setF] = useState({
    titulo: '',
    categoryId: '',
    categoryName: '',
    preco: '49.90',
    custo: '15.00',
    listingType: 'gold_special',
    logisticType: 'cross_docking',
    alt: '', larg: '', comp: '',
    pesoKg: '0.3',
    freteGratis: true,
  })
  const [cats, setCats] = useState([])
  const [predicting, setPredicting] = useState(false)
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const upd = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function predict() {
    if (!f.titulo.trim()) return
    setPredicting(true)
    setCats([])
    try {
      const d = await fetch('/api/predict-category?q=' + encodeURIComponent(f.titulo)).then((r) => r.json())
      setCats(Array.isArray(d) ? d : [])
    } catch {
      setCats([])
    }
    setPredicting(false)
  }

  function pickCat(c) {
    setF({ ...f, categoryId: c.category_id, categoryName: c.category_name })
    setCats([])
  }

  async function calcular() {
    setBusy(true)
    setErr(null)
    setRes(null)
    try {
      const pesoG = Math.round((parseFloat(f.pesoKg) || 0) * 1000)
      const q = new URLSearchParams({
        price: f.preco,
        listing_type: f.listingType,
        logistic_type: f.logisticType,
        weight_grams: String(pesoG),
        free_shipping: String(f.freteGratis),
      })
      if (f.categoryId) q.set('category_id', f.categoryId)
      // dimensões só se preenchidas (formato: altura x largura x comprimento, peso_g)
      if (f.alt && f.larg && f.comp) q.set('dimensions', `${f.alt}x${f.larg}x${f.comp},${pesoG}`)

      const d = await fetch('/api/fees?' + q.toString()).then((r) => r.json())
      if (d.error) throw new Error(d.detail?.message || d.error)
      setRes(d)
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }

  const preco = parseFloat(f.preco) || 0
  const custo = parseFloat(f.custo) || 0
  const comissao = res?.commission_total ?? 0
  const frete = res?.freight ?? 0
  const lucro = res ? preco - custo - comissao - frete : 0
  const lucroPct = res && preco > 0 ? (lucro / preco) * 100 : 0

  return (
    <>
      <div className="grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <h2><span className="n">1</span> Preço e custo</h2>
            <div className="row2">
              <div className="field">
                <label>Por quanto você vende (R$)</label>
                <input type="number" step="0.01" value={f.preco} onChange={upd('preco')} />
              </div>
              <div className="field">
                <label>Quanto o produto te custa (R$)</label>
                <input type="number" step="0.01" value={f.custo} onChange={upd('custo')} />
              </div>
            </div>
          </div>

          <div className="card">
            <h2><span className="n">2</span> Categoria (define a comissão real)</h2>
            <div className="field">
              <label>Descubra pela descrição do produto</label>
              <div className="row-inline">
                <div className="field">
                  <input placeholder="ex: mochila escolar 34 litros" value={f.titulo} onChange={upd('titulo')} />
                </div>
                <button className="ghost" onClick={predict} disabled={predicting}>
                  {predicting ? '…' : 'Buscar'}
                </button>
              </div>
              {cats.map((c) => (
                <button key={c.category_id} className="cat-opt" onClick={() => pickCat(c)}>
                  <b>{c.category_name}</b> — <code>{c.category_id}</code>
                </button>
              ))}
              <div className="hint">
                {f.categoryId
                  ? `Categoria escolhida: ${f.categoryName} (${f.categoryId})`
                  : 'Ou preencha o category_id direto no campo abaixo.'}
              </div>
            </div>
            <div className="field">
              <label>category_id (MLB...)</label>
              <input placeholder="MLB1234" value={f.categoryId} onChange={upd('categoryId')} />
            </div>
            <div className="field">
              <label>Tipo de anúncio</label>
              <select value={f.listingType} onChange={upd('listingType')}>
                {LISTING_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
          </div>

          <div className="card">
            <h2><span className="n">3</span> Envio, peso e tamanho</h2>
            <div className="field">
              <label>Como você despacha</label>
              <select value={f.logisticType} onChange={upd('logisticType')}>
                {LOGISTIC_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Peso da encomenda pronta (kg)</label>
              <input type="number" step="0.01" value={f.pesoKg} onChange={upd('pesoKg')} />
            </div>
            <div className="field">
              <label>Medidas da caixa em cm (altura × largura × comprimento)</label>
              <div className="row3">
                <input type="number" placeholder="Alt." value={f.alt} onChange={upd('alt')} />
                <input type="number" placeholder="Larg." value={f.larg} onChange={upd('larg')} />
                <input type="number" placeholder="Comp." value={f.comp} onChange={upd('comp')} />
              </div>
              <div className="hint">Sem as medidas eu calculo comissão e custo fixo, mas não consigo o frete real.</div>
            </div>
            <label className="check">
              <input type="checkbox" checked={f.freteGratis} onChange={upd('freteGratis')} />
              Vou oferecer frete grátis (abaixo de R$79 é opcional)
            </label>
          </div>

          <button className="primary" onClick={calcular} disabled={busy}>
            {busy ? 'Consultando o Mercado Livre…' : 'Calcular com taxas reais'}
          </button>
        </div>

        <div className="result-card">
          <div className="card">
            <h2><span className="n">✓</span> Resultado {res && <span className="pill">número real do ML</span>}</h2>
            {!res && !err && <p className="spin">Preencha os dados e clique em “Calcular com taxas reais”.</p>}
            {err && <div className="callout bad"><b>Erro:</b> {err}</div>}
            {res && (
              <>
                <div className={'verdict ' + (lucro >= 0 ? 'good' : 'bad')}>
                  <div className="lbl">Sobra pra você por venda</div>
                  <div className="big">{money(lucro)}</div>
                  <div className="pct">{lucroPct.toFixed(1)}% do preço de venda</div>
                </div>
                <div>
                  <div className="brow"><span className="k">Você vende por</span><span className="v">{money(preco)}</span></div>
                  <div className="brow"><span className="k">− Quanto te custou</span><span className="v">− {money(custo)}</span></div>
                  <div className="brow"><span className="k">− Comissão do ML</span><span className="v">− {money(comissao)}</span></div>
                  <div className="brow sub"><span className="k">dentro dela, custo fixo</span><span className="v">{res.fixed_fee > 0 ? money(res.fixed_fee) : '—'}</span></div>
                  <div className="brow">
                    <span className="k">− Frete que você paga</span>
                    <span className="v">{res.freight == null ? '?' : '− ' + money(res.freight)}</span>
                  </div>
                  <div className="brow total"><span className="k">= Sobra no seu bolso</span><span className="v">{money(lucro)}</span></div>
                </div>
                {res.percentage_fee != null && (
                  <div className="hint" style={{ marginTop: 10 }}>Comissão de {res.percentage_fee}% nesta categoria.</div>
                )}
                {res.freight == null && (
                  <div className="callout warn" style={{ marginTop: 12 }}>
                    <b>Sem frete:</b> {res.freight_error ? res.freight_error : 'preencha as medidas da caixa para eu buscar o frete real.'}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="callout">
        <b>Como funciona:</b> a comissão e o custo fixo vêm de <code>/listing_prices</code> e o frete de{' '}
        <code>/shipping_options/free</code>, ambos da sua conta. Ainda não entram na conta: embalagem, imposto do seu
        regime e taxa de parcelamento no cartão.
      </div>

      <footer>
        Números reais da API do Mercado Livre, calculados no momento da consulta. Podem variar por reputação, CEP de
        destino e disponibilidade de promoções de frete.
      </footer>
    </>
  )
}

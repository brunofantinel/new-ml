import { useEffect, useState } from 'react'

const money = (v) =>
  'R$ ' + (v < 0 ? '-' : '') + Math.abs(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const LISTING_TYPES = [
  { id: 'gold_special', label: 'Clássico' },
  { id: 'gold_pro', label: 'Premium' },
]

const LOGISTIC_TYPES = [
  { id: 'cross_docking', label: 'Coleta', desc: 'O Mercado Livre passa no seu endereço e recolhe os pacotes já prontos e etiquetados. Bom pra quem envia bastante de uma vez.' },
  { id: 'xd_drop_off', label: 'Agência (Places)', desc: 'Você leva os pacotes até uma agência ou ponto do Mercado Livre perto de você (Mercado Livre Places).' },
  { id: 'drop_off', label: 'Correios / Drop off', desc: 'Você mesmo posta os pacotes nos Correios ou num ponto de entrega credenciado.' },
  { id: 'fulfillment', label: 'Full', desc: 'Você manda seu estoque pro galpão do Mercado Livre; eles guardam, embalam e enviam por você. Entrega mais rápida e o anúncio aparece melhor, mas tem custo de armazenagem.' },
  { id: 'self_service', label: 'Flex', desc: 'Você (ou um motoboy) entrega no mesmo dia na sua região. O Mercado Livre te paga um valor por cada entrega.' },
]

const pct = (v) => (v == null ? '—' : (v < 0 ? '-' : '') + Math.abs(v * 100).toFixed(1) + '%')

// Nível de reputação do vendedor no Mercado Livre (termômetro verde→vermelho).
const NIVEL = {
  '5_green': { txt: 'Excelente', cor: '#00a650' },
  '4_light_green': { txt: 'Bom', cor: '#7dd956' },
  '3_yellow': { txt: 'Regular', cor: '#e6b800' },
  '2_orange': { txt: 'Ruim', cor: '#ff7733' },
  '1_red': { txt: 'Ruim', cor: '#e64545' },
}
const nivelInfo = (lvl) => NIVEL[lvl] || { txt: 'Novo / sem histórico', cor: '#bbb' }

// Imposto da empresa (Lucro Presumido, comércio) — o app já desconta sozinho.
// Federal sobre a venda: PIS 0,65 + COFINS 3 + IRPJ 1,2 + CSLL 1,08 = 5,93%.
// ICMS fica de fora (depende de estado/produto/substituição tributária). Se o
// contador passar o ICMS efetivo, é só somar aqui.
const IMPOSTO_PCT = 5.93
const imposto = (precoVenda) => ((precoVenda || 0) * IMPOSTO_PCT) / 100

// UF de origem (onde a loja emite) — usada só para saber se a venda é dentro
// do estado. O ICMS total não depende dela (ver ICMS_UF abaixo).
const UF_ORIGEM = 'RS'

// Alíquotas INTERNAS de ICMS por estado de DESTINO (carga cheia, já com FCP
// onde é padrão). Valores aproximados de 2025 — confirme com o contador.
// Para venda a consumidor final (ML), o ICMS total da operação (próprio + DIFAL)
// equivale à alíquota interna do estado de destino; por isso basta esta tabela.
const ICMS_UF = {
  AC: 19, AL: 19, AM: 20, AP: 18, BA: 20.5, CE: 20, DF: 20, ES: 17, GO: 19,
  MA: 23, MG: 18, MS: 17, MT: 17, PA: 19, PB: 20, PE: 20.5, PI: 22.5, PR: 19.5,
  RJ: 22, RN: 20, RO: 19.5, RR: 20, RS: 17, SC: 17, SE: 19, SP: 18, TO: 20,
}
const UF_LISTA = Object.keys(ICMS_UF).sort()

// Sobra recalculada na tela para SEMPRE fechar: preço − seu custo − taxas do ML − imposto.
const margemReal = (i) =>
  i.preco_conc != null && i.custo != null && i.custo_ml != null
    ? i.preco_conc - i.custo - i.custo_ml - imposto(i.preco_conc)
    : null
const margemRealPct = (i) => {
  const m = margemReal(i)
  return m != null && i.preco_conc ? m / i.preco_conc : null
}

const TIER_INFO = {
  competir: { label: '💚 Vale a pena', cls: 'good' },
  conferir: { label: '👀 Dê uma olhada antes', cls: 'warn' },
  apertado: { label: '🔴 Quase não sobra', cls: 'bad' },
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
        <button className={view === 'produto' ? 'tab on' : 'tab'} onClick={() => setView('produto')}>Consultar produto</button>
        <button className={view === 'mercado' ? 'tab on' : 'tab'} onClick={() => setView('mercado')}>Pesquisa de mercado</button>
        <button className={view === 'vantagens' ? 'tab on' : 'tab'} onClick={() => setView('vantagens')}>Vantagens no ML</button>
      </nav>

      {view === 'vantagens' ? (
        <Vantagens />
      ) : view === 'mercado' ? (
        <Mercado />
      ) : view === 'produto' ? (
        <Produto />
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
                  <><b>Conta conectada</b> ✓ — na busca de produto (passo 2) eu já mostro por quanto o concorrente está vendendo.</>
                ) : (
                  <>
                    <b>Dica:</b> na busca de produto (passo 2) eu mostro o preço do concorrente no ML.{' '}
                    Conectar sua conta melhora a precisão.{' '}
                    <a href="/api/auth/login">Conectar minha conta</a>
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
      <div className="eyebrow">O que você paga × o que vendem no Mercado Livre</div>
      <h1>Onde vale a pena vender no Mercado Livre</h1>
      <p className="sub">
        Comparação entre o custo dos seus produtos e o menor preço do mesmo item no Mercado Livre, já descontando as
        taxas do site (comissão e frete) e o imposto federal do Lucro Presumido — o valor final é <b>o que sobraria por
        venda</b>. Use “Ver preço de agora” para atualizar o preço do concorrente. Dados de {db.data_pesquisa}.
      </p>

      <div className="tiles">
        <div className="tile good"><b>{db.contagem.competir}</b><span>valem a pena</span></div>
        <div className="tile warn"><b>{db.contagem.conferir}</b><span>dê uma olhada antes</span></div>
        <div className="tile bad"><b>{db.contagem.apertado}</b><span>quase não sobra</span></div>
        <div className="tile"><b>{money(somaCompetir)}</b><span>sobra somada dos que valem a pena</span></div>
      </div>

      <div className="filters card">
        <input placeholder="Buscar por nome, marca ou código…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(50) }} />
        <select value={tier} onChange={(e) => { setTier(e.target.value); setLimit(50) }}>
          <option value="todos">Mostrar todos</option>
          <option value="competir">Só os que valem a pena</option>
          <option value="conferir">Dar uma olhada antes</option>
          <option value="apertado">Quase não sobra</option>
        </select>
        <select value={grupo} onChange={(e) => { setGrupo(e.target.value); setLimit(50) }}>
          <option value="todos">Todos os tipos de produto</option>
          {grupos.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="margem_rs">Ordenar: maior sobra em R$</option>
          <option value="margem_pct">Ordenar: maior sobra em %</option>
          <option value="score">Ordenar: mais recomendados</option>
          <option value="preco_conc">Ordenar: mais caros no ML</option>
        </select>
      </div>

      <p className="hint">{itens.length} produtos · mostrando os {shown.length} primeiros</p>

      <div className="vlist">
        {shown.map((item) => {
          const lv = live[item.cod]
          const ti = TIER_INFO[item.tier] || { label: item.tier, cls: '' }
          return (
            <div className="vcard card" key={item.cod}>
              <div className="vhead">
                <span className={'pill ' + ti.cls}>{ti.label}</span>
                <span className="vgrp">{item.grupo}</span>
                {item.n_vend != null && <span className="vgrp">{item.n_vend} loja{item.n_vend === 1 ? '' : 's'} vendendo</span>}
                {item.chance === 'ALTA' && <span className="vgrp">boa chance p/ loja nova</span>}
              </div>
              <div className="vname">{item.produto}</div>
              <div className="vsub">{item.marca}{item.produto_ml ? ` · no Mercado Livre: ${item.produto_ml}` : ''}</div>

              <div className="vrows">
                <div className="brow"><span className="k">Você paga (fornecedor)</span><span className="v">{money(item.custo)}</span></div>
                <div className="brow"><span className="k">Mais barato no ML hoje</span><span className="v">{money(item.preco_conc)}</span></div>
                <div className="brow"><span className="k">O Mercado Livre desconta</span><span className="v">− {money(item.custo_ml)}</span></div>
                {item.comissao != null && (
                  <div className="brow sub"><span className="k">↳ comissão do Mercado Livre</span><span className="v">{money(item.comissao)}</span></div>
                )}
                {item.custo_op > 0 && (
                  <div className="brow sub"><span className="k">↳ custo fixo por venda</span><span className="v">{money(item.custo_op)}</span></div>
                )}
                {item.frete > 0 && (
                  <div className="brow sub"><span className="k">↳ frete que você paga</span><span className="v">{money(item.frete)}</span></div>
                )}
                <div className="brow"><span className="k">Imposto (Lucro Presumido {IMPOSTO_PCT}%)</span><span className="v">− {money(imposto(item.preco_conc))}</span></div>
                <div className="brow total">
                  <span className="k">Sobra pra você</span>
                  <span className={'v ' + (margemReal(item) >= 0 ? 'pos' : 'neg')}>{money(margemReal(item))} · {pct(margemRealPct(item))}</span>
                </div>
              </div>

              {lv?.data && (
                <div className={'vlive' + (lv.data.margem_rs != null && lv.data.margem_rs < 0 ? ' neg' : '')}>
                  {lv.data.price_now == null ? (
                    <>⚠️ <b>Agora:</b> ninguém está vendendo esse item no momento.</>
                  ) : (
                    <><b>Preço de hoje:</b> {money(lv.data.price_now)} no ML → sobrariam <b>{money(lv.data.margem_rs - imposto(lv.data.price_now))}</b> ({pct((lv.data.margem_rs - imposto(lv.data.price_now)) / lv.data.price_now)})</>
                  )}
                </div>
              )}
              {lv?.err && <div className="vlive err">Não consegui buscar o preço agora. Tente de novo.</div>}

              <div className="vfoot">
                <button className="ghost" disabled={lv?.loading || !item.catalog_id} onClick={() => atualizar(item)}>
                  {lv?.loading ? 'Buscando preço…' : 'Ver preço de agora'}
                </button>
                {item.url_cat && <a className="ghost link" href={item.url_cat} target="_blank" rel="noreferrer">Abrir no Mercado Livre ▸</a>}
              </div>
              {item.nota && <div className="hint vnote">💬 {item.nota}</div>}
            </div>
          )
        })}
      </div>

      {shown.length < itens.length && (
        <button className="primary" style={{ marginTop: 16 }} onClick={() => setLimit((l) => l + 50)}>
          Ver mais produtos ({itens.length - shown.length} restantes)
        </button>
      )}

      <footer>
        A “sobra pra você” já desconta a comissão e o frete do Mercado Livre e o imposto federal do Lucro Presumido
        ({IMPOSTO_PCT}%: PIS, COFINS, IRPJ e CSLL). Ainda ficam de fora: ICMS, embalagem e a taxa de parcelamento.
        “Ver preço de agora” consulta o valor do produto no site na hora.
      </footer>
    </>
  )
}

function Linha({ k, v }) {
  if (v == null || v === '' ) return null
  return <div className="brow"><span className="k">{k}</span><span className="v">{v}</span></div>
}

function Produto() {
  const [cod, setCod] = useState('')
  const [busy, setBusy] = useState(false)
  const [p, setP] = useState(null)
  const [msg, setMsg] = useState(null)

  async function consultar() {
    const c = cod.trim()
    if (!c) return
    setBusy(true); setMsg(null); setP(null)
    try {
      const d = await fetch('/api/produto?cod=' + encodeURIComponent(c)).then((r) => r.json())
      if (d.encontrado) setP(d)
      else setMsg({
        erp_nao_configurado: 'A conexão com o sistema da loja ainda não foi configurada (ERP_API_URL no servidor).',
        erp_indisponivel: 'O agente da loja está offline. Confira se o computador da loja está ligado e o agente rodando.',
        erp_timeout: 'O sistema da loja demorou para responder. Tente de novo.',
        codigo_invalido: 'Digite um código numérico.',
      }[d.erro] || `Não achei nenhum produto com o código ${c}.`)
    } catch {
      setMsg('Não consegui consultar agora. Tente de novo.')
    }
    setBusy(false)
  }

  const dim = p?.dimensoes || {}
  const imp = p?.impostos_cadastro || {}
  const fe = p?.fiscal_entrada

  return (
    <>
      <div className="eyebrow">Direto do sistema da loja · em tempo real</div>
      <h1>Consultar produto</h1>
      <p className="sub">
        Digite o <b>código interno</b> do produto e veja tudo que o sistema da loja tem sobre ele — descrição, marca,
        NCM, impostos, custo e estoque, na hora.
      </p>

      <div className="card">
        <div className="row-inline">
          <div className="field" style={{ flex: 1 }}>
            <input
              placeholder="código interno do produto (ex: 4346)"
              value={cod}
              inputMode="numeric"
              onChange={(e) => setCod(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') consultar() }}
            />
          </div>
          <button className="primary" onClick={consultar} disabled={busy}>
            {busy ? 'Consultando…' : 'Consultar'}
          </button>
        </div>
        {msg && <div className="callout warn" style={{ marginTop: 10 }}>{msg}</div>}
      </div>

      {p && (
        <>
          <div className="card">
            <div className="mkt-name" style={{ fontSize: 17 }}>{p.descricao}</div>
            <div className="hint" style={{ marginTop: 2 }}>
              código {p.codigo}{p.marca ? ` · ${p.marca}` : ''}{p.referencia ? ` · ref ${p.referencia}` : ''}
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className={'pill ' + (p.ativo ? '' : 'bad')}>{p.ativo ? 'Ativo' : 'Inativo'}</span>
              {p.fora_linha && <span className="pill warn">Fora de linha</span>}
              {fe?.st && <span className="pill">Substituição Tributária</span>}
            </div>
          </div>

          <div className="grid">
            <div className="card">
              <h2>Identificação</h2>
              <Linha k="Código de barras" v={p.codigo_barras} />
              <Linha k="NCM" v={p.ncm} />
              <Linha k="CEST" v={p.cest} />
              <Linha k="Unidade" v={p.unidade} />
              <Linha k="Grupo" v={p.grupo} />
              <Linha k="Subgrupo" v={p.subgrupo} />
              <Linha k="Fornecedor" v={p.fornecedor} />
              <Linha k="Cadastrado em" v={p.dt_cadastro && new Date(p.dt_cadastro).toLocaleDateString('pt-BR')} />
            </div>

            <div className="card">
              <h2>Custo e estoque</h2>
              <Linha k="Último custo" v={p.custo?.ultimo != null ? money(p.custo.ultimo) : null} />
              <Linha k="Custo médio" v={p.custo?.medio != null ? money(p.custo.medio) : null} />
              <Linha k="Estoque" v={p.estoque != null ? `${p.estoque.toLocaleString('pt-BR')} ${p.unidade || ''}`.trim() : '—'} />
              <h2 style={{ marginTop: 16 }}>Dimensões</h2>
              <Linha k="Peso (un.)" v={dim.peso_unit_kg ? `${dim.peso_unit_kg} kg` : null} />
              <Linha k="Peso embalado" v={dim.peso_emb_kg ? `${dim.peso_emb_kg} kg` : null} />
              <Linha k="Alt × Larg × Comp" v={(dim.altura_cm || dim.largura_cm || dim.comprimento_cm) ? `${dim.altura_cm || 0} × ${dim.largura_cm || 0} × ${dim.comprimento_cm || 0} cm` : null} />
              {!dim.peso_unit_kg && !dim.peso_emb_kg && !dim.altura_cm && <div className="hint">Sem medidas cadastradas.</div>}
            </div>
          </div>

          <div className="card">
            <h2>Impostos</h2>
            {fe ? (
              <div className="callout" style={{ marginBottom: 12 }}>
                {fe.st
                  ? <>🟢 Comprado com <b>Substituição Tributária</b> — ICMS já pago na compra (revenda = 0).</>
                  : <>🧾 <b>Não-ST</b> — ICMS de compra (crédito) <b>{fe.icms_compra_pct}%</b> · CFOP {fe.cfop_entrada}.</>}
                {fe.dt_entrada && <div className="hint" style={{ marginTop: 4 }}>Baseado na última nota de entrada de {new Date(fe.dt_entrada).toLocaleDateString('pt-BR')}.</div>}
              </div>
            ) : (
              <div className="hint" style={{ marginBottom: 12 }}>Sem nota de entrada registrada para este produto.</div>
            )}
            <Linha k="ICMS (cadastro)" v={imp.icms_pct != null ? `${imp.icms_pct}%` : null} />
            <Linha k="CSOSN" v={imp.csosn} />
            <Linha k="Substituição tributária (cadastro)" v={imp.subtrib_pct ? `${imp.subtrib_pct}%` : null} />
            <Linha k="PIS" v={imp.pis_pct != null ? `${imp.pis_pct}%` : null} />
            <Linha k="COFINS" v={imp.cofins_pct != null ? `${imp.cofins_pct}%` : null} />
            <Linha k="IPI" v={imp.ipi_pct != null ? `${imp.ipi_pct}%` : null} />
            <Linha k="CST IPI" v={imp.cst_ipi} />
            <Linha k="CFOP (cadastro)" v={imp.cfop} />
          </div>

          {p.observacao && (
            <div className="card"><h2>Observação</h2><div className="hint">{p.observacao}</div></div>
          )}
        </>
      )}

      <footer>
        Dados lidos ao vivo do sistema da loja (somente leitura). Precisa do agente local ligado e do túnel ativo.
      </footer>
    </>
  )
}

function Nivel({ level }) {
  const n = nivelInfo(level)
  return (
    <span className="niv">
      <span className="niv-dot" style={{ background: n.cor }} />
      {n.txt}
    </span>
  )
}

function Mercado() {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState(null)
  const [msg, setMsg] = useState(null)

  async function buscar(termo) {
    const query = (termo ?? q).trim()
    if (!query) return
    setBusy(true); setMsg(null); setData(null)
    try {
      const d = await fetch('/api/mercado?q=' + encodeURIComponent(query)).then((r) => r.json())
      if (!d.matched) {
        setMsg(d.reason === 'sem_resultado'
          ? `Não achei "${query}" no catálogo do Mercado Livre.`
          : d.reason === 'sem_vendedor'
            ? 'Achei o produto, mas ninguém está vendendo agora.'
            : 'Não consegui pesquisar agora.')
        if (d.product) setData(d)
      } else {
        setData(d)
      }
    } catch {
      setMsg('Não consegui pesquisar agora. Tente de novo.')
    }
    setBusy(false)
  }

  const maxVendas = data?.top_vendedores?.[0]?.vendas_hist || 0

  return (
    <>
      <div className="eyebrow">Quem vende, por quanto e quem é o maior</div>
      <h1>Pesquisa de mercado no Mercado Livre</h1>
      <p className="sub">
        Digite um produto e veja <b>quem está vendendo</b>, a <b>faixa de preço</b>, quem está{' '}
        <b>ganhando as vendas</b> (buy box) e <b>quem é a maior loja</b> concorrente.
      </p>

      <div className="card">
        <div className="row-inline">
          <div className="field" style={{ flex: 1 }}>
            <input
              placeholder="ex: caneta bic cristal, mochila kipling, calculadora casio fx-82"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') buscar() }}
            />
          </div>
          <button className="primary" onClick={() => buscar()} disabled={busy}>
            {busy ? 'Pesquisando…' : 'Pesquisar'}
          </button>
        </div>
        {msg && <div className="hint" style={{ marginTop: 10 }}>{msg}</div>}
      </div>

      {data?.product && (
        <>
          <div className="card mkt-prod">
            {data.product.thumbnail && <img src={data.product.thumbnail} alt="" className="mkt-thumb" />}
            <div style={{ flex: 1 }}>
              <div className="mkt-name">{data.product.name}</div>
              <div className="hint">{data.n_vendedores} vendedor{data.n_vendedores === 1 ? '' : 'es'} anunciando este produto</div>
              <a className="ghost link" href={data.product.permalink} target="_blank" rel="noreferrer">Abrir no Mercado Livre ▸</a>
            </div>
          </div>

          {data.n_vendedores > 0 ? (
            <>
              <div className="tiles">
                <div className="tile good"><b>{money(data.preco.min)}</b><span>menor preço</span></div>
                <div className="tile"><b>{money(data.preco.mediana)}</b><span>preço típico (mediana)</span></div>
                <div className="tile bad"><b>{money(data.preco.max)}</b><span>maior preço</span></div>
                <div className="tile"><b>{data.n_vendedores}</b><span>concorrentes</span></div>
              </div>

              {data.winner && (
                <div className="card">
                  <h2>🏆 Quem está ganhando as vendas (buy box)</h2>
                  <div className="mkt-winner">
                    <div>
                      <div className="mkt-seller">{data.winner.nickname}{data.winner.selo && <span className="pill">{data.winner.selo}</span>}</div>
                      <div className="hint"><Nivel level={data.winner.level} /> · {data.winner.uf}{data.winner.cidade ? ` · ${data.winner.cidade}` : ''} · {data.winner.vendas_hist != null ? `${data.winner.vendas_hist.toLocaleString('pt-BR')} vendas na loja` : 'sem histórico'}</div>
                    </div>
                    <div className="mkt-price">
                      <b>{money(data.winner.price)}</b>
                      <span className="hint">{data.winner.tipo}{data.winner.free_shipping ? ' · frete grátis' : ''}</span>
                    </div>
                  </div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    É o anúncio que o ML mostra em destaque — costuma concentrar a maioria das vendas do produto.
                  </div>
                </div>
              )}

              {data.top_vendedores?.length > 0 && (
                <div className="card">
                  <h2>📊 Quem vende mais (maiores lojas)</h2>
                  <div className="mkt-bars">
                    {data.top_vendedores.map((v) => (
                      <div className="mkt-bar-row" key={v.seller_id}>
                        <div className="mkt-bar-lbl">
                          {v.nickname} <Nivel level={v.level} />
                        </div>
                        <div className="mkt-bar-track">
                          <div className="mkt-bar-fill" style={{ width: (maxVendas ? Math.max(4, (v.vendas_hist / maxVendas) * 100) : 4) + '%' }} />
                          <span className="mkt-bar-val">{(v.vendas_hist ?? 0).toLocaleString('pt-BR')} vendas · {money(v.price)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    “Vendas” é o total histórico da loja (todos os produtos) — a API do Mercado Livre não
                    libera a quantidade vendida de cada anúncio. Serve para medir o tamanho do concorrente.
                  </div>
                </div>
              )}

              <div className="card">
                <h2>🧾 Todos os anúncios</h2>
                <div className="hint" style={{ marginBottom: 10 }}>
                  {data.resumo.oficiais} loja{data.resumo.oficiais === 1 ? '' : 's'} oficial ·
                  {' '}{data.resumo.frete_gratis} com frete grátis ·
                  {' '}{data.resumo.premium} anúncio{data.resumo.premium === 1 ? '' : 's'} Premium ·
                  {' '}estados: {Object.entries(data.resumo.por_estado).sort((a, b) => b[1] - a[1]).map(([uf, n]) => `${uf} (${n})`).join(', ')}
                </div>
                <div className="mkt-list">
                  {data.anuncios.map((a) => (
                    <div className={'mkt-item' + (a.winner ? ' win' : '')} key={a.item_id}>
                      <div className="mkt-item-price">{money(a.price)}</div>
                      <div className="mkt-item-sel">
                        <div>{a.nickname} {a.winner && <span className="pill">buy box</span>} {a.oficial && <span className="pill">oficial</span>}</div>
                        <div className="hint"><Nivel level={a.level} /> · {a.uf} · {a.tipo}{a.free_shipping ? ' · frete grátis' : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

            </>
          ) : (
            <div className="card">
              <div className="hint">
                Achei <b>{data.product.name}</b> no catálogo, mas não há vendedor ativo nesse anúncio agora —
                costuma acontecer quando o termo é muito genérico. Tente o nome específico (marca + modelo).
              </div>
            </div>
          )}
          {data.outras_opcoes?.length > 0 && (
            <div className="hint" style={{ marginTop: 4 }}>
              Não é esse? Tente:{' '}
              {data.outras_opcoes.map((o) => (
                <button key={o.id} className="ghost" style={{ margin: '2px 4px' }} onClick={() => { setQ(o.name); buscar(o.name) }}>{o.name}</button>
              ))}
            </div>
          )}
        </>
      )}

      <footer>
        Dados do catálogo do Mercado Livre, buscados na hora. A API pública não expõe a quantidade vendida por
        anúncio; por isso o tamanho do concorrente é medido pelo total de vendas da loja.
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
    codigo: '',
    ufDestino: UF_ORIGEM,
    impostoManual: false,
    manualSt: false,
    manualCredito: '',
    listingType: 'gold_special',
    logisticType: 'cross_docking',
    alt: '', larg: '', comp: '',
    pesoKg: '0.3',
    freteGratis: true,
  })
  const [fiscal, setFiscal] = useState({ loading: false, data: null, err: null })
  const [cats, setCats] = useState([])
  const [predicting, setPredicting] = useState(false)
  const [comp, setComp] = useState(null)
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const upd = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function predict() {
    if (!f.titulo.trim()) return
    setPredicting(true)
    setCats([])
    setComp(null)
    try {
      // busca a categoria e o preço do concorrente ao mesmo tempo
      const [cd, compD] = await Promise.all([
        fetch('/api/predict-category?q=' + encodeURIComponent(f.titulo)).then((r) => r.json()).catch(() => []),
        fetch('/api/competitor?q=' + encodeURIComponent(f.titulo)).then((r) => r.json()).catch(() => null),
      ])
      setCats(Array.isArray(cd) ? cd : [])
      setComp(compD)
    } catch {
      setCats([])
      setComp(null)
    }
    setPredicting(false)
  }

  function pickCat(c) {
    setF({ ...f, categoryId: c.category_id, categoryName: c.category_name })
    setCats([])
  }

  async function buscarImposto() {
    const cod = f.codigo.trim()
    if (!cod) return
    setFiscal({ loading: true, data: null, err: null })
    try {
      const d = await fetch('/api/imposto?cod=' + encodeURIComponent(cod)).then((r) => r.json())
      setFiscal({ loading: false, data: d, err: null })
    } catch {
      setFiscal({ loading: false, data: null, err: 'Não consegui consultar o imposto agora.' })
    }
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
  // fonte do ICMS: manual (se marcado) tem prioridade sobre a busca por código/NCM
  const fic = f.impostoManual
    ? { st: f.manualSt, ic: parseFloat(f.manualCredito) || 0, por: 'manual' }
    : (fiscal.data?.encontrado ? fiscal.data : null)
  // ICMS líquido = débito na venda (alíquota interna do destino × preço)
  //              − crédito da compra (ICMS destacado na entrada × custo).
  // Para ST o débito e o crédito são zero (ICMS já pago na compra).
  const internaDest = ICMS_UF[f.ufDestino] ?? 0
  const icmsDebito = res && fic && !fic.st ? (preco * internaDest) / 100 : 0
  const icmsCredito = res && fic && !fic.st ? (custo * (fic.ic || 0)) / 100 : 0
  const icmsVal = Math.max(0, icmsDebito - icmsCredito)
  const interestadual = f.ufDestino !== UF_ORIGEM
  const impostoFederalVal = res ? imposto(preco) : 0
  const impostoVal = impostoFederalVal + icmsVal
  const lucro = res ? preco - custo - comissao - frete - impostoVal : 0
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
            <div className="field">
              <label>Código de barras, código do produto ou NCM (traz o ICMS real)</label>
              <div className="row-inline">
                <div className="field">
                  <input
                    placeholder="ex: 7891153044323  ·  ou o NCM 48201000"
                    value={f.codigo}
                    onChange={upd('codigo')}
                    onKeyDown={(e) => { if (e.key === 'Enter') buscarImposto() }}
                  />
                </div>
                <button className="ghost" onClick={buscarImposto} disabled={fiscal.loading}>
                  {fiscal.loading ? '…' : 'Buscar imposto'}
                </button>
              </div>
              {fiscal.data && (fiscal.data.encontrado ? (
                <div className="callout" style={{ margin: '10px 0 0' }}>
                  {fiscal.data.por === 'ncm' ? (
                    fiscal.data.st ? (
                      <>🟢 <b>NCM {fiscal.data.ncm}</b> — normalmente <b>ST</b> ({Math.round(fiscal.data.share * 100)}% dos
                      seus produtos desse NCM). ICMS na revenda ≈ <b>0</b>.</>
                    ) : (
                      <>🧾 <b>NCM {fiscal.data.ncm}</b> — normalmente <b>não-ST</b>. Crédito típico de compra{' '}
                      <b>{fiscal.data.ic}%</b>. O ICMS sai pelo estado de destino.</>
                    )
                  ) : fiscal.data.st ? (
                    <>🟢 <b>{fiscal.data.descr}</b> — <b>Substituição Tributária</b>: o ICMS já foi pago na compra,
                    então na revenda o <b>ICMS = 0</b>.</>
                  ) : (
                    <>🧾 <b>{fiscal.data.descr}</b> — não-ST{fiscal.data.ncm ? ` (NCM ${fiscal.data.ncm})` : ''}.
                    O ICMS é calculado pelo estado de destino, já abatendo o <b>crédito de {fiscal.data.ic}%</b> da
                    compra. Escolha o destino abaixo.</>
                  )}
                  <div className="hint" style={{ marginTop: 6 }}>
                    {fiscal.data.por === 'ncm'
                      ? `Estimado pelo NCM (média de ${fiscal.data.n} produto(s) seus). Se quiser precisão, use o código de barras ou ajuste manual abaixo.`
                      : `Origem: notas de entrada do seu ERP${fiscal.data.por === 'cod' ? ' (achado pelo código interno)' : ''}. Alíquotas internas por estado são aproximadas — confirme com o contador.`}
                  </div>
                </div>
              ) : (
                <div className="hint" style={{ marginTop: 8 }}>
                  {fiscal.data.erro === 'mapa_ausente'
                    ? 'A base de impostos ainda não foi gerada (rode o extrator do ERP).'
                    : 'Não achei esse código nem esse NCM na sua base. Use o ajuste manual abaixo.'}
                </div>
              ))}
              {fiscal.err && <div className="hint" style={{ marginTop: 8 }}>{fiscal.err}</div>}
            </div>
            <div className="field">
              <label>Estado do comprador (destino da venda)</label>
              <select value={f.ufDestino} onChange={upd('ufDestino')}>
                {UF_LISTA.map((uf) => (
                  <option key={uf} value={uf}>
                    {uf}{uf === UF_ORIGEM ? ' — seu estado' : ''} · ICMS interno {ICMS_UF[uf]}%
                  </option>
                ))}
              </select>
              <div className="hint">
                {f.ufDestino === UF_ORIGEM
                  ? 'Venda dentro do seu estado — sem DIFAL.'
                  : `Venda interestadual (${UF_ORIGEM}→${f.ufDestino}) — o DIFAL já está embutido na alíquota interna do destino.`}
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={f.impostoManual} onChange={upd('impostoManual')} />
              Informar o imposto manualmente (ex.: pesquisei o NCM e quero digitar)
            </label>
            {f.impostoManual && (
              <div className="row2" style={{ marginTop: 8 }}>
                <label className="check">
                  <input type="checkbox" checked={f.manualSt} onChange={upd('manualSt')} />
                  É ST — ICMS já pago na compra (revenda = 0)
                </label>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>ICMS que você pagou na compra (crédito) %</label>
                  <input type="number" step="0.01" placeholder="ex: 12" value={f.manualCredito}
                    onChange={upd('manualCredito')} disabled={f.manualSt} />
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <h2><span className="n">2</span> Categoria (define a comissão real)</h2>
            <div className="field">
              <label>Descubra a categoria e o preço do concorrente</label>
              <div className="row-inline">
                <div className="field">
                  <input placeholder="ex: mochila escolar 34 litros" value={f.titulo} onChange={upd('titulo')} />
                </div>
                <button className="ghost" onClick={predict} disabled={predicting}>
                  {predicting ? '…' : 'Buscar'}
                </button>
              </div>

              {comp && (comp.matched ? (
                <div className="callout" style={{ margin: '10px 0 0' }}>
                  💰 <b>No Mercado Livre</b> o mais barato hoje é <b>{money(comp.price)}</b>
                  {comp.n_vend ? ` (${comp.n_vend} loja${comp.n_vend === 1 ? '' : 's'} vendendo)` : ''}.
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="ghost" onClick={() => setF({ ...f, preco: String(comp.price) })}>Usar esse preço</button>
                    {comp.category_id && (
                      <button className="ghost" onClick={() => setF({ ...f, categoryId: comp.category_id, categoryName: 'mesma do concorrente' })}>Usar a categoria</button>
                    )}
                    {comp.url && <a className="ghost link" href={comp.url} target="_blank" rel="noreferrer">Ver no ML ▸</a>}
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>Produto no ML: {comp.name}</div>
                </div>
              ) : (
                <div className="hint" style={{ marginTop: 8 }}>
                  {comp.reason === 'sem_preco'
                    ? `Achei “${comp.name}” no ML, mas ninguém está vendendo esse item agora.`
                    : 'Não achei esse produto no Mercado Livre para comparar o preço.'}
                </div>
              ))}

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
              <div className="hint">{LOGISTIC_TYPES.find((t) => t.id === f.logisticType)?.desc}</div>
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
                  <div className="brow"><span className="k">− Imposto federal (Lucro Presumido {IMPOSTO_PCT}%)</span><span className="v">− {money(impostoFederalVal)}</span></div>
                  {fic && fic.st ? (
                    <div className="brow"><span className="k">− ICMS na revenda · ST (pago na compra)</span><span className="v">− {money(0)}</span></div>
                  ) : fic ? (
                    <>
                      <div className="brow"><span className="k">− ICMS líquido{interestadual ? ' (com DIFAL)' : ''}</span><span className="v">− {money(icmsVal)}</span></div>
                      <div className="brow sub"><span className="k">↳ débito na venda ({internaDest}% p/ {f.ufDestino})</span><span className="v">{money(icmsDebito)}</span></div>
                      <div className="brow sub"><span className="k">↳ crédito da compra ({fic.ic || 0}% do custo)</span><span className="v">− {money(icmsCredito)}</span></div>
                    </>
                  ) : (
                    <div className="brow"><span className="k">− ICMS na revenda</span><span className="v">não incluído</span></div>
                  )}
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
        <b>Como funciona:</b> a comissão e o frete vêm direto do Mercado Livre, com os valores reais da sua conta, e o
        imposto federal do Lucro Presumido ({IMPOSTO_PCT}%) já é descontado automaticamente. Informando o código do
        produto, o <b>ICMS</b> também entra: <b>zero</b> nos itens com Substituição Tributária (já pago na compra); nos
        demais, é o <b>ICMS líquido</b> = débito da venda (alíquota interna do estado de destino, com o <b>DIFAL</b> já
        embutido) menos o <b>crédito</b> do ICMS pago na compra. Ainda ficam de fora: embalagem e a taxa de parcelamento.
      </div>

      <footer>
        Valores reais do Mercado Livre, buscados na hora do cálculo. Podem mudar conforme a reputação da loja, o CEP de
        destino e as promoções de frete do momento.
      </footer>
    </>
  )
}

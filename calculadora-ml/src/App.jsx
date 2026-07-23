import { useEffect, useRef, useState } from 'react'
import {
  MODALIDADES, MODALIDADE_IDS, getModalidade,
  pesoCobravelKg, pesoVolumetricoKg, checarLimites, compararModalidades,
} from '../server/freight.js'
import iconSearch from './assets/icon-search.svg' // ícone exportado do Figma

const money = (v) =>
  'R$ ' + (v < 0 ? '-' : '') + Math.abs(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Cada tipo de anúncio muda o parcelamento e a exposição — é o que a
// exposicao-info-table mostra logo abaixo do seletor.
const LISTING_TYPES = [
  {
    id: 'gold_special',
    label: 'Clássico',
    parcelamento: 'Com juros para o comprador',
    exposicao: 'Exposição média',
  },
  {
    id: 'gold_pro',
    label: 'Premium',
    parcelamento: 'Sem juros para o comprador',
    exposicao: 'Alta exposição',
  },
]

// As modalidades (limites de peso/medidas e regra de custo) vivem em
// server/freight.js — mesmo código que o backend usa, pra tela e cálculo nunca
// divergirem. Aqui só montamos a lista pro <select>.
const LOGISTIC_TYPES = MODALIDADE_IDS.map((id) => ({
  id,
  label: MODALIDADES[id].label,
  desc: MODALIDADES[id].despacho,
}))

// Desconto de frete por reputação (regra de 02/03/2026: até 70% acima de R$79).
// Os percentuais por medalha são aproximados — confirme no seu painel do ML.
const REPUTACOES = [
  { id: '0', label: 'Sem reputação / vermelha–laranja (sem desconto)', desc: 0 },
  { id: '0.2', label: 'Amarela (~20% de desconto)', desc: 0.2 },
  { id: '0.4', label: 'Verde-claro / Decola (~40% de desconto)', desc: 0.4 },
  { id: '0.55', label: 'MercadoLíder (~55% de desconto)', desc: 0.55 },
  { id: '0.7', label: 'MercadoLíder Platinum (~70% de desconto)', desc: 0.7 },
]

// Texto curto dos limites da modalidade, pra mostrar embaixo do seletor.
const textoLimites = (lim) => [
  lim.pesoKg != null ? `até ${lim.pesoKg} kg` : null,
  lim.somaCm != null ? `soma dos lados até ${lim.somaCm} cm` : null,
  lim.maiorLadoCm != null ? `maior lado até ${lim.maiorLadoCm} cm` : null,
].filter(Boolean).join(' · ')

const pct = (v) => (v == null ? '—' : (v < 0 ? '-' : '') + Math.abs(v * 100).toFixed(1) + '%')

// Nível de reputação do vendedor no Mercado Livre (termômetro verde→vermelho).
const NIVEL = {
  '5_green': { txt: 'Excelente', cor: 'var(--c-ml-green)' },
  '4_light_green': { txt: 'Bom', cor: 'var(--c-ml-light-green)' },
  '3_yellow': { txt: 'Regular', cor: 'var(--c-ml-yellow)' },
  '2_orange': { txt: 'Ruim', cor: 'var(--c-ml-orange)' },
  '1_red': { txt: 'Ruim', cor: 'var(--c-ml-red)' },
}
const nivelInfo = (lvl) => NIVEL[lvl] || { txt: 'Novo / sem histórico', cor: 'var(--c-ml-none)' }

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

// Como o anúncio foi encontrado (qual identificador casou).
const VIA_TXT = {
  codigo_barras: 'código de barras',
  codigo_barras_nf: 'código de barras da NF',
  referencia: 'referência',
  descricao: 'descrição',
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

  return (
    <>
      <div className="eyebrow">Direto do sistema da loja · em tempo real</div>
      <h1>Consultar produto</h1>
      <p className="sub">
        Digite o <b>código interno</b> do produto e veja o que o sistema da loja tem sobre ele — descrição, marca,
        NCM, custo e estoque, na hora.
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

// Avalia o quão competitivo está o SEU preço de venda vs a média dos anúncios
// ativos do mesmo produto no Mercado Livre. mercado = { min, mediana, max }.
// Devolve { tone, titulo, msg } ou null se não houver mercado pra comparar.
function avaliarPreco(preco, custo, mercado) {
  const m = mercado?.mediana
  if (!preco || !m) return null
  const diff = (preco - m) / m // > 0 = mais caro que a média do mercado
  const pctTxt = `${Math.abs(diff * 100).toFixed(0)}%`

  // O mercado já vende abaixo do seu custo: competir dá prejuízo.
  if (custo > 0 && m < custo) {
    return {
      tone: 'bad',
      titulo: '🛑 Não compensa vender',
      msg: `No ML a média é ~${money(m)}, abaixo do seu custo (${money(custo)}). Não dá pra competir sem sair no prejuízo.`,
    }
  }
  if (diff <= -0.20) return {
    tone: 'good', titulo: '🚀 Grande potencial de venda!',
    msg: `Seu preço (${money(preco)}) está ${pctTxt} abaixo da média dos anúncios (${money(m)}). Tende a vender rápido.`,
  }
  if (diff <= -0.05) return {
    tone: 'good', titulo: '👍 Preço competitivo',
    msg: `Está ${pctTxt} abaixo da média do ML (${money(m)}). Boa posição pra vender.`,
  }
  if (diff <= 0.05) return {
    tone: 'ok', titulo: '➖ Na média do mercado',
    msg: `Seu preço está bem próximo da média dos anúncios (${money(m)}).`,
  }
  if (diff <= 0.20) return {
    tone: 'warn', titulo: '⚠️ Um pouco caro',
    msg: `Está ${pctTxt} acima da média (${money(m)}). Pode vender mais devagar.`,
  }
  return {
    tone: 'bad', titulo: '🛑 Muito caro pro mercado',
    msg: `Está ${pctTxt} acima da média dos anúncios (${money(m)}). Difícil vender — considere baixar o preço.`,
  }
}

// Modal que abre a câmera (traseira no celular) e lê o código de barras ao vivo.
// Funciona em Android e iPhone (Safari/Chrome) via @zxing/browser. Precisa HTTPS.
// Calibrado: só formatos de barras (EAN/UPC/CODE-128/ITF), TRY_HARDER, resolução
// alta, quadro de mira e lanterna (onde o aparelho suporta).
function ScannerModal({ onDetect, onClose }) {
  const videoRef = useRef(null)
  const trackRef = useRef(null)
  const [err, setErr] = useState(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchOk, setTorchOk] = useState(false)

  useEffect(() => {
    let controls = null
    let done = false
    let cancelado = false
    // carrega o leitor sob demanda (mantém o app leve até abrir a câmera)
    Promise.all([import('@zxing/browser'), import('@zxing/library')])
      .then(([{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }]) => {
        if (cancelado) return
        const hints = new Map()
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.ITF,
        ])
        hints.set(DecodeHintType.TRY_HARDER, true)
        const reader = new BrowserMultiFormatReader(hints)
        const constraints = { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } }
        return reader.decodeFromConstraints(constraints, videoRef.current, (result, _e, ctrl) => {
          controls = ctrl
          if (result && !done) {
            done = true
            try { ctrl.stop() } catch { /* noop */ }
            onDetect(result.getText())
          }
        })
      })
      .then((c) => {
        if (c) controls = c
        // detecta suporte a lanterna (torch) no aparelho
        try {
          const track = videoRef.current?.srcObject?.getVideoTracks?.()[0]
          trackRef.current = track
          if (track?.getCapabilities?.().torch) setTorchOk(true)
        } catch { /* noop */ }
      })
      .catch((e) => setErr('Não consegui abrir a câmera. Verifique a permissão e o HTTPS. (' + (e?.message || e) + ')'))
    return () => { cancelado = true; try { controls && controls.stop() } catch { /* noop */ } }
  }, [])

  async function toggleTorch() {
    const track = trackRef.current
    if (!track) return
    try {
      const novo = !torchOn
      await track.applyConstraints({ advanced: [{ torch: novo }] })
      setTorchOn(novo)
    } catch { /* alguns aparelhos não permitem */ }
  }

  return (
    <div className="scan-overlay">
      <div className="scan-title">Centralize o código na faixa verde</div>
      <div className="scan-stage">
        <video ref={videoRef} muted playsInline />
        {/* quadro de mira */}
        <div className="scan-aim">
          <div className="scan-frame">
            <div className="scan-laser" />
          </div>
        </div>
      </div>
      {err && <div className="scan-err">{err}</div>}
      <div className="scan-actions">
        {torchOk && (
          <button className="ghost on-dark" onClick={toggleTorch}>
            {torchOn ? '🔦 Apagar' : '🔦 Lanterna'}
          </button>
        )}
        <button className="primary" onClick={onClose}>Fechar</button>
      </div>
      <div className="scan-help">
        Aproxime até o código preencher a faixa, com boa luz. Segure firme por 1–2 s.
      </div>
    </div>
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
    barras: '',
    listingType: 'gold_special',
    logisticType: 'drop_off', // padrão da loja: Correios
    alt: '', larg: '', comp: '',
    pesoKg: '0.3',
    freteGratis: true,
    reputacao: '0.4', // Decola = verde-claro (o % real vem da cotação da conta)
    elegivel: true,   // produto NOVO e elegível (condição do subsídio R$19–78,99)
    custoFull: '',    // Full: armazenagem/operação por unidade
    custoFlex: '',    // Flex: quanto o motoboy/transportadora cobra de fato
  })
  const [produtoDb, setProdutoDb] = useState(null) // resultado ao vivo do /api/produto (agente do ERP)
  const [dbBusy, setDbBusy] = useState(false)
  const [dbMsg, setDbMsg] = useState(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [cats, setCats] = useState([])
  const [predicting, setPredicting] = useState(false)
  const [comp, setComp] = useState(null)
  const [compIdx, setCompIdx] = useState(0) // qual candidato "é o seu produto"
  const [res, setRes] = useState(null)
  const [anuncios, setAnuncios] = useState({ loading: false, data: null })
  const [tendencia, setTendencia] = useState({ loading: false, data: null })
  const [janelaDias, setJanelaDias] = useState(60) // janela do termômetro de procura
  const [anuncioPrep, setAnuncioPrep] = useState({ loading: false, data: null })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // Campo HÍBRIDO da categoria. Ele mostra o id do ML (MLB1234) que veio do
  // produto escolhido no carrossel; mas se a pessoa digitar texto ("eletrônicos"),
  // vira uma busca por nome e as sugestões aparecem embaixo pra escolher.
  const [catInput, setCatInput] = useState('')
  const [buscandoCat, setBuscandoCat] = useState(false)
  const catTimer = useRef(null) // debounce da busca enquanto digita

  const ehIdMlb = (v) => /^MLB\d+$/i.test(String(v).trim())

  const upd = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  // Limpa TUDO que era do produto anterior — chamado ao pesquisar/puxar um novo,
  // pra a tela nunca misturar dados de dois produtos.
  function limparResultados() {
    setComp(null); setCompIdx(0)
    setCats([])
    setRes(null); setErr(null)
    setAnuncios({ loading: false, data: null })
    setTendencia({ loading: false, data: null })
    setAnuncioPrep({ loading: false, data: null })
  }

  // term: texto a pesquisar (default = campo título). autoPick: quando true, já
  // escolhe a melhor categoria (preenche o category_id) e deixa as demais como
  // alternativas — usado ao puxar o produto do banco.
  async function predict(term, autoPick = false) {
    const query = (typeof term === 'string' ? term : f.titulo).trim()
    if (!query) return
    setPredicting(true)
    limparResultados() // some com tudo do produto anterior
    try {
      // busca a categoria e o preço do concorrente ao mesmo tempo
      const [cd, compD] = await Promise.all([
        fetch('/api/predict-category?q=' + encodeURIComponent(query)).then((r) => r.json()).catch(() => []),
        fetch('/api/competitor?q=' + encodeURIComponent(query)).then((r) => r.json()).catch(() => null),
      ])
      // A rota já devolve até 3 sugestões ordenadas por confiança (categorias
      // reais de produtos parecidos primeiro, palpites por palavra-chave depois).
      // Mostramos todas como chips pra dar mais chance de acerto e já deixamos a
      // melhor (a primeira) pré-selecionada — o usuário troca com um clique.
      let list = Array.isArray(cd) ? cd : []
      // Garante a categoria do concorrente na lista (é o mesmo produto no ML).
      if (compD?.matched && compD.category_id && !list.some((c) => c.category_id === compD.category_id)) {
        list = [{ category_id: compD.category_id, category_name: compD.category_name || 'mesma do concorrente', category_path: compD.category_path || '', source: 'produto' }, ...list].slice(0, 3)
      }
      setComp(compD)
      setCats(list)
      if (list.length) {
        aplicarCategoria(list[0].category_id, list[0].category_name)
      } else {
        // sem sugestão: zera a categoria em vez de deixar a do produto anterior
        // pendurada na tela (o campo e o "Categoria escolhida" leem daqui)
        aplicarCategoria('', '')
      }
    } catch {
      setCats([])
      setComp(null)
    }
    setPredicting(false)
  }

  // Aplica uma categoria vinda de FORA do campo (produto do carrossel, parse do
  // banco, clique numa sugestão) — o campo passa a mostrar o id dela.
  function aplicarCategoria(id, nome) {
    setF((prev) => ({ ...prev, categoryId: id || '', categoryName: nome || '' }))
    setCatInput(id || '')
  }

  // Digitação no campo híbrido:
  //  - "MLB1234"       → é o id, assume direto
  //  - "eletrônicos"   → busca por nome e lista as sugestões pra escolher
  // Enquanto o texto não for um id, não há categoria escolhida — a pessoa
  // precisa clicar numa sugestão (senão o id seguiria valendo o do produto
  // anterior sem ela perceber).
  function onCatInput(v) {
    setCatInput(v)
    clearTimeout(catTimer.current)
    const t = v.trim()

    if (!t) { setCats([]); setF((p) => ({ ...p, categoryId: '', categoryName: '' })); return }
    if (ehIdMlb(t)) { setCats([]); setF((p) => ({ ...p, categoryId: t, categoryName: '' })); return }

    setF((p) => ({ ...p, categoryId: '', categoryName: '' }))
    if (t.length < 3) { setCats([]); return }
    catTimer.current = setTimeout(async () => {
      setBuscandoCat(true)
      try {
        const d = await fetch('/api/buscar-categoria?q=' + encodeURIComponent(t)).then((r) => r.json())
        setCats(Array.isArray(d) ? d : [])
      } catch {
        setCats([])
      }
      setBuscandoCat(false)
    }, 350)
  }

  function pickCat(c) {
    // Mantém a lista na tela (não limpa) — só troca a categoria escolhida.
    aplicarCategoria(c.category_id, c.category_name)
  }

  // Preenche os campos a partir do produto vindo do banco (por código ou barras):
  // preço de venda, ÚLTIMO CUSTO (já com impostos/custos), peso e medidas. Sem fiscal.
  function preencherProduto(d) {
    setProdutoDb(d)
    const dim = d.dimensoes || {}
    const peso = dim.peso_emb_kg || dim.peso_unit_kg
    setF((prev) => ({
      ...prev,
      // já assume o preço de venda cadastrado no banco (o usuário pode editar)
      preco: d.preco_venda != null ? String(d.preco_venda) : prev.preco,
      custo: d.custo?.ultimo != null ? String(d.custo.ultimo) : prev.custo,
      titulo: prev.titulo || d.descricao || '',
      codigo: d.codigo != null ? String(d.codigo) : prev.codigo,
      barras: d.codigo_barras || prev.barras,
      pesoKg: peso != null ? String(peso) : prev.pesoKg,
      alt: dim.altura_cm != null ? String(dim.altura_cm) : prev.alt,
      larg: dim.largura_cm != null ? String(dim.largura_cm) : prev.larg,
      comp: dim.comprimento_cm != null ? String(dim.comprimento_cm) : prev.comp,
    }))
    // já tenta descobrir a categoria/comissão e o concorrente pela descrição
    if (d.descricao) predict(d.descricao, true)
  }

  const msgErpErro = (erro, alvo) => ({
    erp_nao_configurado: 'A conexão com o banco da loja ainda não foi configurada no servidor.',
    erp_indisponivel: 'O agente da loja está offline.',
    erp_timeout: 'O banco demorou a responder.',
    codigo_invalido: 'Digite o código interno (numérico) do produto.',
    barras_invalido: 'Código de barras inválido.',
  }[erro] || `Não achei ${alvo} no banco da loja.`)

  // Puxa do banco pelo CÓDIGO INTERNO.
  async function puxarDoBanco() {
    const c = f.codigo.trim().replace(/\D/g, '')
    if (!c) return
    setDbBusy(true); setDbMsg(null); setProdutoDb(null)
    limparResultados()
    try {
      const d = await fetch('/api/produto?cod=' + encodeURIComponent(c)).then((r) => r.json())
      if (d.encontrado) preencherProduto(d)
      else setDbMsg(msgErpErro(d.erro, `o produto ${c}`))
    } catch {
      setDbMsg('Não consegui puxar do banco agora. Tente de novo.')
    }
    setDbBusy(false)
  }

  // Puxa do banco pelo CÓDIGO DE BARRAS (escaneado ou digitado).
  async function puxarPorBarras(barras) {
    const b = String(barras ?? f.barras).replace(/\D/g, '')
    if (!b) return
    setScanOpen(false)
    setDbBusy(true); setDbMsg(null); setProdutoDb(null)
    limparResultados()
    setF((prev) => ({ ...prev, barras: b }))
    try {
      const d = await fetch('/api/produto-barras?barras=' + encodeURIComponent(b)).then((r) => r.json())
      if (d.encontrado) preencherProduto(d)
      else setDbMsg(msgErpErro(d.erro, `o código de barras ${b}`))
    } catch {
      setDbMsg('Não consegui consultar agora. Tente de novo.')
    }
    setDbBusy(false)
  }

  // Botão único "Buscar": usa o CÓDIGO INTERNO se preenchido; senão, o BARRAS.
  function buscarProduto() {
    if (f.codigo.trim().replace(/\D/g, '')) { puxarDoBanco(); return }
    if (f.barras.trim().replace(/\D/g, '')) { puxarPorBarras(); return }
    setDbMsg('Digite o código interno ou o código de barras.')
  }

  // Busca os anúncios desse produto no ML tentando os identificadores em ordem
  // de precisão: código de barras (GTIN) -> referência -> descrição.
  async function buscarAnunciosProduto(nomeOverride) {
    // Se veio o nome do candidato escolhido, busca por ele (produto confirmado).
    const gtin = nomeOverride ? '' : (produtoDb?.codigo_barras || '')
    const ref = nomeOverride ? '' : (produtoDb?.referencia || '')
    const nome = nomeOverride || produtoDb?.descricao || f.titulo || ''
    if (!gtin && !ref && !nome.trim()) return
    setAnuncios({ loading: true, data: null })
    setTendencia({ loading: false, data: null })
    try {
      const qs = new URLSearchParams()
      if (gtin) qs.set('gtin', gtin)
      if (ref) qs.set('ref', ref)
      if (nome) qs.set('nome', nome)
      const d = await fetch('/api/anuncios?' + qs.toString()).then((r) => r.json())
      setAnuncios({ loading: false, data: d })
      // termômetro de procura (visitas) dos anúncios desse produto
      const ids = Array.isArray(d?.anuncios) ? d.anuncios.map((a) => a.item_id).filter(Boolean) : []
      if (ids.length) buscarTendencia(ids)
    } catch {
      setAnuncios({ loading: false, data: null })
    }
  }

  // Termômetro de procura: puxa as visitas (últimos 60 dias) dos anúncios do
  // produto e diz se a procura está subindo, estável ou caindo. Sem banco.
  async function buscarTendencia(ids, dias = janelaDias) {
    if (!ids?.length) { setTendencia({ loading: false, data: null }); return }
    setTendencia({ loading: true, data: null })
    try {
      const d = await fetch('/api/tendencia?ids=' + encodeURIComponent(ids.slice(0, 6).join(',')) + '&dias=' + dias).then((r) => r.json())
      setTendencia({ loading: false, data: d })
    } catch {
      setTendencia({ loading: false, data: null })
    }
  }

  // Monta um RASCUNHO do anúncio e mostra na tela para revisão. NÃO publica
  // nada no Mercado Livre. Junta: o que veio do catálogo do ML (título, fotos,
  // marca/modelo — quando o produto existe lá), os dados do banco (quantidade,
  // GTIN, NCM) e o que você digitou manualmente (peso e medidas do passo 3).
  // Quando o produto não está no catálogo, preenche só com o que houver.
  async function prepararAnuncio() {
    setAnuncioPrep({ loading: true, data: null })
    const cAtivo = comp?.candidatos?.[compIdx] || comp
    const catId = comp?.matched ? (cAtivo?.catalog_id || '') : ''
    let base = { catalog: null, required_attributes: [] }
    try {
      base = await fetch(
        '/api/anuncio?catalog_id=' + encodeURIComponent(catId || '') +
        '&category_id=' + encodeURIComponent(f.categoryId || '')
      ).then((r) => r.json())
    } catch { /* segue com o que tiver */ }

    const attr = (id) => base.catalog?.attributes?.find((a) => a.id === id)?.value || null
    const draft = {
      viaCatalogo: !!base.catalog?.matched,
      catalogId: catId || null,
      catalogUrl: cAtivo?.url || null,
      titulo: base.catalog?.title || produtoDb?.descricao || cAtivo?.name || f.titulo || '',
      categoriaNome: f.categoryName || null,
      categoriaId: f.categoryId || null,
      preco: parseFloat(f.preco) || null,
      quantidade: produtoDb?.estoque ?? null,
      tipoAnuncio: LISTING_TYPES.find((t) => t.id === f.listingType)?.label || f.listingType,
      condicao: 'Novo',
      marca: attr('BRAND') || produtoDb?.marca || null,
      modelo: attr('MODEL') || produtoDb?.referencia || null,
      gtin: produtoDb?.codigo_barras || null,
      ncm: produtoDb?.ncm || null,
      pesoKg: parseFloat(f.pesoKg) || null,          // MANUAL (passo 3)
      dimensoes: (f.alt && f.larg && f.comp) ? `${f.alt} × ${f.larg} × ${f.comp} cm` : null, // MANUAL
      fotos: base.catalog?.pictures || [],
      atributosObrigatorios: base.required_attributes || [],
    }
    setAnuncioPrep({ loading: false, data: draft })
  }

  async function calcular() {
    setBusy(true)
    setErr(null)
    setRes(null)
    setAnuncios({ loading: false, data: null })
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
      // desconto de frete por reputação (aplicado acima de R$79)
      if (f.reputacao && f.reputacao !== '0') q.set('reputation_discount', f.reputacao)
      // produto novo e elegível: condição pro ML cobrir o frete de R$19 a R$78,99
      if (!f.elegivel) q.set('eligible', 'false')
      // custos próprios da modalidade escolhida
      if (f.logisticType === 'fulfillment' && f.custoFull) q.set('full_op_cost', f.custoFull)
      if (f.logisticType === 'self_service' && f.custoFlex) q.set('flex_delivery_cost', f.custoFlex)

      const d = await fetch('/api/fees?' + q.toString()).then((r) => r.json())
      if (d.error) throw new Error(d.detail?.message || d.error)
      setRes(d)
      // anúncios do produto CONFIRMADO (candidato escolhido), se houver
      const nomeSel = comp?.candidatos?.[compIdx]?.name || comp?.name
      buscarAnunciosProduto(nomeSel)
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }

  const preco = parseFloat(f.preco) || 0
  const custo = parseFloat(f.custo) || 0

  // --- Pacote: peso cobrável e limites da modalidade (calculado ao vivo, sem
  // precisar clicar em "Calcular" — é só peso e medidas). ---
  const pesoRealKg = parseFloat(f.pesoKg) || 0
  const dimsForm = {
    alturaCm: parseFloat(f.alt) || 0,
    larguraCm: parseFloat(f.larg) || 0,
    comprimentoCm: parseFloat(f.comp) || 0,
  }
  const modalidade = getModalidade(f.logisticType)
  const pesoVol = pesoVolumetricoKg(dimsForm.alturaCm, dimsForm.larguraCm, dimsForm.comprimentoCm)
  const pesoCob = pesoCobravelKg(pesoRealKg, dimsForm)
  const limites = checarLimites(f.logisticType, pesoRealKg, dimsForm)
  // Simulação lado a lado das 5 modalidades com o MESMO pacote. Não diz o que
  // está liberado pra conta — só o custo estimado e se cabe nos limites.
  const comparativo = compararModalidades(preco, pesoRealKg, f.freteGratis, {
    ...dimsForm,
    descontoReputacao: Number(f.reputacao) || 0,
    elegivelSubsidio: f.elegivel,
    custoOperacaoFull: parseFloat(f.custoFull) || 0,
    custoEntregaFlex: f.custoFlex === '' ? null : parseFloat(f.custoFlex) || 0,
  })

  const comissao = res?.commission_total ?? 0
  const frete = res?.freight ?? 0
  // O "último custo" do banco já traz os impostos/custos da COMPRA embutidos.
  // Sobre a VENDA descontamos: imposto federal (Lucro Presumido) sempre, e o
  // ICMS — que muda conforme o estado do comprador (tabela por UF mais abaixo).
  const impostoFederal = res ? imposto(preco) : 0
  // "Sobra antes do ICMS" = preço − custo − comissão − frete − imposto federal.
  const lucro = res ? preco - custo - comissao - frete - impostoFederal : 0
  const lucroPct = res && preco > 0 ? (lucro / preco) * 100 : 0
  // Sobra final em cada estado de destino (cada UF tem um ICMS diferente).
  const sobraPorUF = res
    ? UF_LISTA.map((uf) => {
        const icmsRs = (preco * ICMS_UF[uf]) / 100
        const sobra = lucro - icmsRs
        return { uf, icmsPct: ICMS_UF[uf], icmsRs, sobra }
      })
    : []
  // posicionamento do seu preço vs a média dos anúncios do mesmo produto no ML
  const mercado = anuncios.data?.matched && anuncios.data?.preco?.mediana != null ? anuncios.data.preco : null
  const aval = res ? avaliarPreco(preco, custo, mercado) : null
  // produto ativo = o candidato que o usuário confirmou ("é este seu produto?")
  const candidatos = comp?.candidatos || []
  const compAtivo = candidatos[compIdx] || comp
  // categoria escolhida hoje, pra mostrar o caminho completo na caixa verde
  const catAtiva = cats.find((c) => c.category_id === f.categoryId) || null

  // ao escolher outro candidato: troca a seleção, aplica a categoria dele e
  // re-busca os anúncios/termômetro daquele produto.
  function escolherCandidato(i) {
    setCompIdx(i)
    const cand = candidatos[i]
    if (!cand) return
    // escolher o produto no carrossel já puxa o id da categoria dele
    if (cand.category_id) aplicarCategoria(cand.category_id, cand.category_name || 'mesma do concorrente')
    buscarAnunciosProduto(cand.name)
  }

  return (
    <>
      {scanOpen && (
        <ScannerModal onDetect={(code) => puxarPorBarras(code)} onClose={() => setScanOpen(false)} />
      )}
      <div className="grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <h2><span className="n">1</span> Preço e custo</h2>

            {/* 1º: buscar o produto no banco (por código interno OU por barras) */}
            <div className="lookup-box">
              <label>Código interno de produto</label>
              <div className="hint" style={{ marginTop: -3, marginBottom: 8 }}>Puxa preço de venda, último custo, peso e medidas do banco.</div>
              <input
                placeholder="ex: 4346"
                value={f.codigo}
                inputMode="numeric"
                onChange={upd('codigo')}
                onKeyDown={(e) => { if (e.key === 'Enter') buscarProduto() }}
              />
              <div className="divider-ou"><span>ou código de barras (EAN)</span></div>
              <input
                placeholder="Digite o EAN"
                value={f.barras}
                inputMode="numeric"
                onChange={upd('barras')}
                onKeyDown={(e) => { if (e.key === 'Enter') buscarProduto() }}
              />
              <button className="ghost" style={{ width: '100%', marginTop: 10 }} onClick={() => setScanOpen(true)}>📷 Escanear</button>
              <button className="ghost" style={{ width: '100%', marginTop: 8 }} onClick={buscarProduto} disabled={dbBusy}>
                {dbBusy ? 'Buscando…' : 'Buscar'}
              </button>
            </div>

            {dbMsg && <div className="hint" style={{ marginTop: 10 }}>{dbMsg}</div>}
            {produtoDb && (
              <div className="callout" style={{ margin: '12px 0 0' }}>
                ✓ <b>{produtoDb.descricao}</b> — puxado do banco da loja.
                <div className="hint" style={{ marginTop: 6 }}>
                  Custo (último): <b>{produtoDb.custo?.ultimo != null ? money(produtoDb.custo.ultimo) : '—'}</b>
                  {produtoDb.custo?.medio != null && ` · médio ${money(produtoDb.custo.medio)}`}
                  {produtoDb.ncm && ` · NCM ${produtoDb.ncm}`}
                  {(produtoDb.dimensoes?.peso_emb_kg || produtoDb.dimensoes?.peso_unit_kg) &&
                    ` · ${produtoDb.dimensoes.peso_emb_kg || produtoDb.dimensoes.peso_unit_kg} kg`}
                </div>
              </div>
            )}

            {/* 2º: preço e custo (vêm do banco acima, ou você digita) */}
            <div className="row2" style={{ marginTop: 16 }}>
              <div className="field">
                <label>Por quanto você vende (R$)</label>
                <input type="number" step="0.01" value={f.preco} onChange={upd('preco')} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Quanto o produto te custa (R$)</label>
                <input type="number" step="0.01" value={f.custo} onChange={upd('custo')} />
              </div>
            </div>
          </div>

          <div className="card">
            <h2><span className="n">2</span> Categoria</h2>

            {/* ── Qual seu produto? + carrossel de candidatos (nó 2484:3143) ── */}
            {comp && comp.matched && candidatos.length > 0 && (
              <>
                <div className="prod-header">
                  <div className="prod-header-txt">
                    <p className="t">Qual seu produto?</p>
                    <p className="d">Escolha qual é o seu produto</p>
                  </div>
                  <span className="prod-badge">
                    {candidatos.length} {candidatos.length === 1 ? 'opção' : 'opções'}
                  </span>
                </div>
                <div className="prod-track">
                  {candidatos.map((cand, i) => {
                    const sel = i === compIdx
                    return (
                      <div key={cand.catalog_id} className={'prod-card' + (sel ? ' on' : '')}>
                        {sel && <span className="prod-sel">✓ Selecionado</span>}
                        <button className="prod-pic" onClick={() => escolherCandidato(i)}>
                          {cand.thumbnail
                            ? <img src={cand.thumbnail} alt="" />
                            : <span className="prod-pic-vazia">sem foto</span>}
                        </button>
                        <button className="prod-info" onClick={() => escolherCandidato(i)}>
                          <span className="nome">{cand.name}</span>
                          {cand.n_vend ? <span className="lojas">{cand.n_vend} {cand.n_vend === 1 ? 'loja vendendo' : 'lojas vendendo'}</span> : null}
                          <span className="preco">{money(cand.price)}</span>
                          {cand.category_name && <span className="cat">{cand.category_name}</span>}
                        </button>
                        {cand.url && (
                          <a className="prod-cta" href={cand.url} target="_blank" rel="noreferrer">
                            Ver no Mercado Livre ›
                          </a>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
            {comp && !comp.matched && (
              <div className="hint">
                {comp.reason === 'sem_preco'
                  ? `Achei “${comp.name}” no ML, mas ninguém está vendendo esse item agora.`
                  : 'Não achei esse produto no Mercado Livre para comparar o preço.'}
              </div>
            )}

            {/* ── Id da categoria (nó 2484:3106) — campo HÍBRIDO ── */}
            <div className="field">
              <label>Id da categoria no Mercado Livre</label>
              <div className="id-field">
                <img src={iconSearch} alt="" />
                <input
                  placeholder="MLB1234 ou o nome da categoria"
                  value={catInput}
                  onChange={(e) => onCatInput(e.target.value)}
                />
                {buscandoCat && <span className="id-field-busy">…</span>}
              </div>
              <div className="hint">
                Escolher o produto acima já traz o id. Ou digite o nome — ex.:{' '}
                <b>Eletrônicos</b> — que eu sugiro as categorias aqui embaixo.
              </div>
            </div>

            {/* ── Categoria escolhida (nó 2484:3181) ── */}
            {f.categoryId && (
              <div className="cat-chosen">
                <p className="t">✓ {f.categoryName || 'Categoria'} — <span>{f.categoryId}</span></p>
                {catAtiva?.category_path && <p className="p">{catAtiva.category_path}</p>}
              </div>
            )}

            {/* ── Resultados da busca: lista de categorias (nó 2484:3198) ── */}
            {cats.length > 0 && (
              <>
                <div className="res-title">
                  <p className="t">Resultados da busca</p>
                  <p className="d">Selecione a categoria mais adequada para o seu produto.</p>
                </div>
                <div className="cat-list">
                  {cats.map((c) => {
                    const sel = c.category_id === f.categoryId
                    return (
                      <button
                        key={c.category_id}
                        type="button"
                        className={'cat-item' + (sel ? ' on' : '')}
                        onClick={() => pickCat(c)}
                      >
                        <span className="radio" aria-hidden />
                        <span className="info">
                          <span className="path">{c.category_path || c.category_name}</span>
                          <span className="tag">{c.category_id}</span>
                          {c.source === 'palpite' && <span className="guess">palpite por palavra</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
            <div className="field">
              <label>Tipo de anúncio</label>
              {/* segmented control (chips-row do design) */}
              <div className="segmented">
                {LISTING_TYPES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={f.listingType === t.id ? 'on' : ''}
                    onClick={() => setF({ ...f, listingType: t.id })}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* exposicao-info-table: o que o tipo de anúncio escolhido significa.
                A tarifa só aparece depois do cálculo — ela vem da categoria. */}
            {(() => {
              const lt = LISTING_TYPES.find((t) => t.id === f.listingType)
              // só mostra a tarifa se o cálculo na tela for DESTE tipo de anúncio —
              // trocar de Clássico pra Premium invalida o número anterior
              const temTarifa = res && res.percentage_fee != null && res.listing_type === f.listingType
              return (
                <div className="info-table">
                  <div className="info-row">
                    <span className="k">Tarifa sobre a venda:</span>
                    <span className="v mono">
                      {temTarifa
                        ? `${res.percentage_fee}%${res.fixed_fee > 0 ? ` + ${money(res.fixed_fee)}` : ''}`
                        : '— calcule pra ver'}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="k">Parcelamento:</span>
                    <span className="v plain">{lt?.parcelamento}</span>
                  </div>
                  <div className="info-row">
                    <span className="k">Exposição:</span>
                    <span className="v accent">{lt?.exposicao}</span>
                  </div>
                </div>
              )
            })()}
          </div>

          <div className="card">
            <h2><span className="n">3</span> Envio, peso e tamanho</h2>
            <div className="field">
              <label>Como você despacha</label>
              <select value={f.logisticType} onChange={upd('logisticType')}>
                {LOGISTIC_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <div className="hint">{LOGISTIC_TYPES.find((t) => t.id === f.logisticType)?.desc}</div>
              <div className="hint" style={{ marginTop: 4 }}>
                <b>Limites desta modalidade:</b> {textoLimites(modalidade.limites)}
              </div>
              {modalidade.notas?.map((n, i) => (
                <div key={i} className="hint" style={{ marginTop: 2 }}>• {n}</div>
              ))}
            </div>
            <div className="field">
              <label>Peso da encomenda pronta (kg)</label>
              <input type="number" step="0.01" value={f.pesoKg} onChange={upd('pesoKg')} />
            </div>
            {/* dimensions-row do design: cada medida com seu próprio rótulo */}
            <div className="field">
              <div className="row3">
                <div className="field">
                  <label className="plain">Altura (cm)</label>
                  <input type="number" placeholder="0" value={f.alt} onChange={upd('alt')} />
                </div>
                <div className="field">
                  <label className="plain">Largura (cm)</label>
                  <input type="number" placeholder="0" value={f.larg} onChange={upd('larg')} />
                </div>
                <div className="field">
                  <label className="plain">Comprimento (cm)</label>
                  <input type="number" placeholder="0" value={f.comp} onChange={upd('comp')} />
                </div>
              </div>
              <div className="hint">Sem as medidas eu calculo comissão e custo fixo, mas não consigo o frete real.</div>
            </div>

            {/* Peso cobrável e limites — recalculado enquanto você digita. */}
            <div className={'pack-box' + (limites.ok ? '' : ' bad')}>
              <div className="pack-row">
                <span>Peso cobrável (o maior entre real e volumétrico)</span>
                <b>{pesoCob > 0 ? `${pesoCob.toFixed(2)} kg` : '—'}</b>
              </div>
              <div className="hint">
                real {pesoRealKg ? `${pesoRealKg} kg` : '—'} · volumétrico{' '}
                {pesoVol > 0 ? `${pesoVol.toFixed(2)} kg` : '— (preencha as medidas)'}
                {pesoVol > 0 && ' (A × L × C ÷ 6000)'}
              </div>
              {limites.tem_medidas && (
                <div className="hint">
                  soma dos lados <b className={limites.excedeu.soma ? 'over' : undefined}>{limites.soma_cm} cm</b>
                  {' · '}maior lado <b className={limites.excedeu.lado ? 'over' : undefined}>{limites.maior_lado_cm} cm</b>
                </div>
              )}
              {!limites.ok && (
                <div className="pack-alerts">
                  {limites.mensagens.map((m, i) => <div key={i}>⚠ {m}</div>)}
                </div>
              )}
            </div>

            {/* Custos próprios de cada modalidade — a tabela de frete não cobre. */}
            {f.logisticType === 'fulfillment' && (
              <div className="field" style={{ marginTop: 12 }}>
                <label>Full: armazenagem e operação por unidade (R$)</label>
                <input type="number" step="0.01" placeholder="ex: 1.50" value={f.custoFull} onChange={upd('custoFull')} />
                <div className="hint">
                  O Full não é custo zero. Acima de R$79 o ML cobre 50% do frete grátis; armazenagem,
                  operação e estoque antigo continuam na sua margem. Coloque aqui o rateio por unidade.
                </div>
              </div>
            )}
            {f.logisticType === 'self_service' && (
              <div className="field" style={{ marginTop: 12 }}>
                <label>Flex: quanto VOCÊ paga pela entrega (R$)</label>
                <input type="number" step="0.01" placeholder="ex: 12.00" value={f.custoFlex} onChange={upd('custoFlex')} />
                <div className="hint">
                  O ML cobre 100% da <b>tarifa da plataforma</b> na faixa R$19–78,99 e ~10% acima de R$79
                  (reputação verde) — não o que o seu motoboy cobra. A diferença é custo (ou lucro) logístico seu.
                  Em branco, assumo que o entregador cobra o mesmo que a tarifa do ML.
                </div>
              </div>
            )}

            <div className="field" style={{ marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={f.elegivel} onChange={upd('elegivel')} style={{ width: 'auto' }} />
                Produto novo e elegível ao frete grátis do ML
              </label>
              <div className="hint">
                É a condição pro Mercado Livre cobrir o frete na faixa de R$19 a R$78,99. Desmarque se o
                produto for usado/recondicionado ou não elegível — aí o custo do envio volta pra você.
              </div>
            </div>

            <div className="hint" style={{ marginTop: 10 }}>
              Conta no Decola = reputação <b>verde-claro</b> (uso ~40% de desconto acima de R$79), mas isso
              não libera todas as modalidades nem torna qualquer frete grátis. O que está disponível depende de
              cobertura, endereço, categoria, dimensões e da liberação do ML — por isso a modalidade nunca é
              marcada sozinha. Com o vendedor conectado, o valor vem da cotação real da conta.
            </div>
          </div>

          {/* Comparativo: o mesmo pacote nas 5 modalidades. */}
          <div className="card">
            <h2>📦 O mesmo pacote em cada modalidade</h2>
            <div className="hint" style={{ marginBottom: 10 }}>
              Estimativa com {pesoCob > 0 ? `${pesoCob.toFixed(2)} kg cobráveis` : 'o peso informado'} e preço de {money(preco)}.
              Mostra o custo e se o pacote cabe nos limites — não indica o que está liberado pra sua conta.
            </div>
            <div className="mod-list">
              {comparativo.map((c) => {
                const sel = c.modalidade === f.logisticType
                const cabe = c.limites.ok
                return (
                  <button
                    key={c.modalidade}
                    type="button"
                    className={'mod-item' + (sel ? ' on' : '') + (cabe ? '' : ' over')}
                    onClick={() => setF({ ...f, logisticType: c.modalidade })}
                  >
                    <div className="mod-head">
                      <span className="mod-name">{sel ? '✓ ' : ''}{c.modalidade_label}</span>
                      <span className={'mod-cost' + (c.custo_total > 0 ? '' : ' free')}>
                        {c.custo_total === 0 ? 'R$ 0,00' : money(c.custo_total)}
                      </span>
                    </div>
                    <div className="hint">{c.regra}</div>
                    <div className="hint">
                      tarifa cheia {money(c.tarifa_base)}
                      {/* o desconto de reputação incide na tabela (tradicional e Full).
                          No Flex o ML paga um % da tarifa cheia — por isso não aparece aqui. */}
                      {c.modelo !== 'flex' && c.desconto_reputacao > 0 && ` · −${Math.round(c.desconto_reputacao * 100)}% reputação`}
                      {c.cobertura_ml_pct > 0 && (c.modelo === 'flex'
                        ? ` · ML te paga ${money(c.recebe_do_ml)} (${Math.round(c.cobertura_ml_pct * 100)}% da tarifa)`
                        : ` · ML cobre ${Math.round(c.cobertura_ml_pct * 100)}%`)}
                      {c.modelo === 'flex' && ` · entrega por sua conta`}
                      {c.custo_extra > 0 && ` · + ${money(c.custo_extra)} de operação`}
                    </div>
                    {!cabe && (
                      <div className="mod-warn">
                        ⚠ não cabe nos limites ({textoLimites(c.limites.limites)})
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
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
                  <div className="lbl">Sobra pra você (antes do ICMS estadual)</div>
                  {/* valor grande + pílula do percentual na mesma linha (result-hero-card) */}
                  <div className="row">
                    <div className="big">{money(lucro)}</div>
                    <div className="pct">{lucroPct.toFixed(1)}%</div>
                  </div>
                </div>
                {aval && (
                  <div className={'aval ' + (aval.tone || 'ok')}>
                    <div className="t">{aval.titulo}</div>
                    <div className="m">{aval.msg}</div>
                    <div className="d">
                      No ML: menor <b>{money(anuncios.data.preco.min)}</b> · média <b>{money(anuncios.data.preco.mediana)}</b> · maior <b>{money(anuncios.data.preco.max)}</b>
                      {anuncios.data.n_vendedores ? ` · ${anuncios.data.n_vendedores} anúncio${anuncios.data.n_vendedores === 1 ? '' : 's'}` : ''}
                    </div>
                  </div>
                )}
                {res && !mercado && anuncios.loading && (
                  <div className="hint" style={{ margin: '10px 0 0' }}>Comparando com os anúncios do ML…</div>
                )}
                {res && !mercado && !anuncios.loading && anuncios.data && (
                  <div className="hint" style={{ margin: '10px 0 0' }}>
                    Sem anúncios ativos desse produto no ML pra comparar o preço. Preencha o título no passo 2 pra eu achar.
                  </div>
                )}
                <div>
                  <div className="brow"><span className="k">Você vende por</span><span className="v">{money(preco)}</span></div>
                  <div className="brow"><span className="k">− Quanto o produto te custou</span><span className="v">− {money(custo)}</span></div>
                  <div className="brow"><span className="k">− Comissão do Mercado Livre</span><span className="v">− {money(comissao)}</span></div>
                  <div className="brow sub"><span className="k">↳ dentro dela, taxa fixa por venda</span><span className="v">{res.fixed_fee > 0 ? money(res.fixed_fee) : '—'}</span></div>
                  <div className="brow">
                    <span className="k">− Frete que sai do seu bolso{res.freight_source === 'estimate' && res.freight != null ? ' (estimado)' : ''}</span>
                    <span className="v">{res.freight == null ? '?' : '− ' + money(res.freight)}</span>
                  </div>
                  {res.freight_detail && (
                    <div className="brow sub"><span className="k">↳ {res.freight_detail.modalidade_label}: {res.freight_detail.regra}</span><span className="v" /></div>
                  )}
                  {res.freight_detail?.peso_cobravel_kg > 0 && (
                    <div className="brow sub">
                      <span className="k">
                        ↳ peso cobrável {res.freight_detail.peso_cobravel_kg} kg
                        {res.freight_detail.peso_volumetrico_kg > res.freight_detail.peso_real_kg
                          ? ` (volumétrico — o real é ${res.freight_detail.peso_real_kg} kg)`
                          : ' (peso real)'}
                        {' · tarifa cheia '}{money(res.freight_detail.tarifa_base)}
                      </span>
                      <span className="v" />
                    </div>
                  )}
                  {res.freight_detail?.modelo === 'flex' && res.freight_detail.recebe_do_ml > 0 && (
                    <div className="brow sub"><span className="k">↳ o ML te paga {money(res.freight_detail.recebe_do_ml)} de incentivo; a entrega em si é paga por você</span><span className="v" /></div>
                  )}
                  {res.freight_detail?.custo_extra > 0 && (
                    <div className="brow sub"><span className="k">↳ inclui {money(res.freight_detail.custo_extra)} de armazenagem/operação do Full</span><span className="v" /></div>
                  )}
                  {res.freight_free_by_meli && (
                    <div className="brow sub"><span className="k">↳ o Mercado Livre confirmou que cobre o frete nesta faixa</span><span className="v" /></div>
                  )}
                  {res.freight_source === 'api' && res.freight > 0 && (
                    <div className="brow sub"><span className="k">↳ cotação real da sua conta no ML — já com os seus descontos</span><span className="v" /></div>
                  )}
                  <div className="brow"><span className="k">− Imposto federal (Lucro Presumido {IMPOSTO_PCT}%)</span><span className="v">− {money(impostoFederal)}</span></div>
                  <div className="brow sub"><span className="k">↳ PIS, COFINS, IRPJ e CSLL sobre a venda</span><span className="v" /></div>
                  <div className="brow total"><span className="k">= Sobra antes do ICMS</span><span className="v">{money(lucro)}</span></div>
                  <div className="brow sub"><span className="k">↳ o custo do banco (“último custo”) já inclui os impostos da compra. Falta só o ICMS, que muda por estado — veja a tabela abaixo.</span><span className="v" /></div>
                </div>

                <div>
                  <div className="sec-title">Sobra final por estado do comprador (já com ICMS)</div>
                  <div className="hint" style={{ marginBottom: 10 }}>
                    O ICMS depende do estado de destino da venda. Abaixo, o que realmente sobra em cada estado — comissão, frete e imposto federal já descontados. O número ao lado da sigla é a alíquota de ICMS usada.
                  </div>
                  <div className="uf-grid">
                    {sobraPorUF.map((s) => (
                      <div key={s.uf} className={'uf-tile' + (s.sobra >= 0 ? '' : ' neg')}>
                        <span className="uf">{s.uf}</span>
                        <span className="icms">{s.icmsPct}%</span>
                        <span className="val">{money(s.sobra)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {res.percentage_fee != null && (
                  <div className="hint" style={{ marginTop: 10 }}>O Mercado Livre fica com {res.percentage_fee}% de comissão nessa categoria.</div>
                )}
                {res.freight_limits && !res.freight_limits.ok && (
                  <div className="callout bad" style={{ marginTop: 12 }}>
                    <b>Fora dos limites de {res.freight_limits.modalidade_label}:</b>
                    {res.freight_limits.mensagens.map((m, i) => <div key={i} style={{ marginTop: 4 }}>{m}</div>)}
                  </div>
                )}
                {res.freight_detail?.avisos?.length > 0 && (
                  <div className="hint" style={{ marginTop: 10 }}>
                    {res.freight_detail.avisos.map((a, i) => <div key={i} style={{ marginTop: 2 }}>• {a}</div>)}
                  </div>
                )}
                {res.freight == null && (
                  <div className="callout warn" style={{ marginTop: 12 }}>
                    <b>Sem frete:</b> {res.freight_error ? res.freight_error : 'preencha as medidas da caixa para eu buscar o frete real.'}
                  </div>
                )}
                <button className="primary" style={{ marginTop: 14 }} onClick={prepararAnuncio} disabled={anuncioPrep.loading}>
                  {anuncioPrep.loading ? 'Preparando…' : '📋 Preparar anúncio'}
                </button>
              </>
            )}
          </div>

          {anuncioPrep.data && (
            <div className="card">
              <h2>📋 Rascunho do anúncio <span className="pill">só revisão — não publica</span></h2>
              {anuncioPrep.data.viaCatalogo ? (
                <div className="callout" style={{ margin: '0 0 12px' }}>
                  ✅ <b>Vinculado ao catálogo do ML</b> — título, fotos e atributos vêm prontos do produto no Mercado Livre.
                  {anuncioPrep.data.catalogUrl && (
                    <> <a href={anuncioPrep.data.catalogUrl} target="_blank" rel="noreferrer">ver produto ▸</a></>
                  )}
                </div>
              ) : (
                <div className="callout warn" style={{ margin: '0 0 12px' }}>
                  ⚠️ <b>Produto não está no catálogo do ML</b> — preenchi com o que havia. Ao publicar, você precisará adicionar as <b>fotos</b> e os atributos obrigatórios.
                </div>
              )}

              {anuncioPrep.data.fotos.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {anuncioPrep.data.fotos.slice(0, 6).map((u, i) => (
                    <img key={i} className="draft-photo" src={u} alt="" />
                  ))}
                </div>
              )}

              <div>
                <div className="brow"><span className="k">Título</span><span className="v">{anuncioPrep.data.titulo || <span className="hint">— a preencher</span>}</span></div>
                <div className="brow"><span className="k">Categoria</span><span className="v">{anuncioPrep.data.categoriaNome ? `${anuncioPrep.data.categoriaNome} (${anuncioPrep.data.categoriaId})` : <span className="hint">— a preencher</span>}</span></div>
                <div className="brow"><span className="k">Preço</span><span className="v">{anuncioPrep.data.preco != null ? money(anuncioPrep.data.preco) : <span className="hint">— a preencher</span>}</span></div>
                <div className="brow"><span className="k">Quantidade (estoque)</span><span className="v">{anuncioPrep.data.quantidade != null ? anuncioPrep.data.quantidade : <span className="hint">— a preencher</span>}</span></div>
                <div className="brow"><span className="k">Tipo de anúncio</span><span className="v">{anuncioPrep.data.tipoAnuncio}</span></div>
                <div className="brow"><span className="k">Condição</span><span className="v">{anuncioPrep.data.condicao}</span></div>
                <div className="brow"><span className="k">Marca</span><span className="v">{anuncioPrep.data.marca || <span className="hint">— a preencher</span>}</span></div>
                <div className="brow"><span className="k">Modelo</span><span className="v">{anuncioPrep.data.modelo || <span className="hint">— a preencher</span>}</span></div>
                <div className="brow"><span className="k">GTIN (cód. de barras)</span><span className="v">{anuncioPrep.data.gtin || <span className="hint">— a preencher</span>}</span></div>
                <div className="brow"><span className="k">Peso (você informou)</span><span className="v">{anuncioPrep.data.pesoKg != null ? `${anuncioPrep.data.pesoKg} kg` : <span className="hint">— a preencher</span>}</span></div>
                <div className="brow"><span className="k">Dimensões (você informou)</span><span className="v">{anuncioPrep.data.dimensoes || <span className="hint">— a preencher</span>}</span></div>
                {anuncioPrep.data.ncm && <div className="brow"><span className="k">NCM (nota fiscal)</span><span className="v">{anuncioPrep.data.ncm}</span></div>}
              </div>

              {anuncioPrep.data.atributosObrigatorios.length > 0 && (
                <div className="hint" style={{ marginTop: 10 }}>
                  O ML exige nesta categoria: {anuncioPrep.data.atributosObrigatorios.map((x) => x.name).join(', ')}.
                </div>
              )}
              <div className="hint" style={{ marginTop: 8 }}>
                Nada foi publicado — isto é só um resumo pronto para anunciar, pra você conferir.
              </div>
            </div>
          )}

          {(anuncios.loading || anuncios.data) && (
            <div className="card">
              <h2>🛒 Anúncios desse produto no Mercado Livre</h2>
              {anuncios.loading ? (
                <p className="spin">Procurando anúncios…</p>
              ) : anuncios.data?.matched && (anuncios.data?.n_vendedores || 0) > 0 ? (
                <>
                  <div className="mkt-prod">
                    {anuncios.data.product.thumbnail && <img src={anuncios.data.product.thumbnail} alt="" className="mkt-thumb" />}
                    <div style={{ flex: 1 }}>
                      <div className="mkt-name">{anuncios.data.product.name}</div>
                      <div className="hint">
                        {anuncios.data.n_vendedores} vendedor{anuncios.data.n_vendedores === 1 ? '' : 'es'}
                        {anuncios.data.via ? ` · achado pela ${VIA_TXT[anuncios.data.via] || 'busca'}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="tiles" style={{ marginTop: 10 }}>
                    <div className="tile good"><b>{money(anuncios.data.preco.min)}</b><span>menor preço</span></div>
                    <div className="tile"><b>{money(anuncios.data.preco.mediana)}</b><span>típico</span></div>
                    <div className="tile bad"><b>{money(anuncios.data.preco.max)}</b><span>maior preço</span></div>
                  </div>
                  <a className="primary" style={{ display: 'block', textAlign: 'center', marginTop: 12 }}
                    href={anuncios.data.product.permalink} target="_blank" rel="noreferrer">
                    Ver anúncios no Mercado Livre ▸
                  </a>
                  {anuncios.data.anuncios?.length > 0 && (
                    <div className="mkt-list" style={{ marginTop: 12 }}>
                      {anuncios.data.anuncios.slice(0, 6).map((a) => (
                        <a className={'mkt-item' + (a.winner ? ' win' : '')} key={a.item_id}
                          href={a.permalink} target="_blank" rel="noreferrer"
                          style={{ textDecoration: 'none', color: 'inherit' }}>
                          <div className="mkt-item-price">{money(a.price)}</div>
                          <div className="mkt-item-sel">
                            <div>{a.nickname} {a.winner && <span className="pill">buy box</span>} {a.oficial && <span className="pill">oficial</span>}</div>
                            <div className="hint">{a.uf} · {a.tipo}{a.free_shipping ? ' · frete grátis' : ''}</div>
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="hint" style={{ marginTop: 8 }}>Clique num anúncio (ou no botão) para abrir no Mercado Livre.</div>
                </>
              ) : (
                <div className="hint">
                  Não achei anúncios ativos desse produto no ML — tentei pelo{' '}
                  {produtoDb ? 'código de barras, referência e descrição' : 'nome digitado'}.
                </div>
              )}
            </div>
          )}

          {(tendencia.loading || tendencia.data) && (
            <div className="card">
              <h2>📈 Termômetro de procura <span className="pill">visitas</span></h2>
              <div className="field">
                <label className="plain">Janela de análise</label>
                {/* segmented control (chips-row do design) */}
                <div className="segmented">
                  {[30, 60, 90].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={janelaDias === d ? 'on' : ''}
                      onClick={() => {
                        setJanelaDias(d)
                        const ids = (anuncios.data?.anuncios || []).map((a) => a.item_id).filter(Boolean)
                        buscarTendencia(ids, d)
                      }}
                    >
                      {d} dias
                    </button>
                  ))}
                </div>
              </div>
              {tendencia.loading ? (
                <p className="spin">Medindo a procura…</p>
              ) : tendencia.data?.encontrado ? (() => {
                const t = tendencia.data
                // stable-demand-card do design: barra de destaque à esquerda + conteúdo
                const c = {
                  subindo: { tone: 'up', emo: '📈', txt: 'Procura em ALTA' },
                  caindo: { tone: 'down', emo: '📉', txt: 'Procura em QUEDA' },
                  estavel: { tone: 'flat', emo: '➖', txt: 'Procura ESTÁVEL' },
                }[t.direcao] || { tone: 'flat', emo: '➖', txt: 'Procura' }
                return (
                  <div className={'demand-card ' + c.tone}>
                    <div className="accent" />
                    <div className="body">
                      <div className="t">
                        {c.emo} {c.txt}{t.change_pct != null ? ` (${t.change_pct > 0 ? '+' : ''}${t.change_pct}%)` : ''}
                      </div>
                      <div className="m">
                        Últimos {t.meia_janela} dias: <b>{t.recente}</b> visitas · {t.meia_janela} dias anteriores: <b>{t.antigo}</b>
                      </div>
                      <div className="d">
                        Somado de {t.n_itens} anúncio{t.n_itens === 1 ? '' : 's'} do produto. Visita mede procura/interesse, não venda.
                        {t.sinal_fraco ? ' ⚠️ Pouco tráfego — sinal fraco, leve como pista.' : ''}
                      </div>
                    </div>
                  </div>
                )
              })() : (
                <div className="hint">Sem visitas suficientes para medir a procura deste produto.</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="callout">
        <b>Como funciona:</b> a comissão e o frete vêm direto do Mercado Livre, com os valores reais da sua conta. O
        <b> custo</b> vem do <b>“último custo”</b> do banco, que já inclui os impostos e custos da compra. Sobre a venda o app
        desconta o <b>imposto federal</b> (Lucro Presumido {IMPOSTO_PCT}%: PIS, COFINS, IRPJ e CSLL) e o <b>ICMS</b>, que muda
        conforme o estado do comprador (por isso a tabela por estado). A sobra é preço − custo − comissão − frete − imposto
        federal − ICMS do estado. O ICMS usado é uma <b>estimativa</b> por alíquota interna cheia — não considera ICMS-ST,
        benefício fiscal nem crédito. Ainda ficam de fora: a embalagem e a taxa de parcelamento.
      </div>

      <footer>
        Valores reais do Mercado Livre, buscados na hora do cálculo. Podem mudar conforme a reputação da loja, o CEP de
        destino e as promoções de frete do momento.
      </footer>
    </>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
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

// ---- Publicar anúncio ----
const CONDICOES = [{ id: 'new', label: 'Novo' }, { id: 'used', label: 'Usado' }]
const WARRANTY_TYPES = ['Garantia do vendedor', 'Garantia de fábrica', 'Sem garantia']
// Palavras/termos que o ML não permite no título (viram infração ou reprovam a
// publicação). Bloqueamos no cliente pra o usuário corrigir antes de validar.
const TITULO_PROIBIDO = /frete\s*gr[áa]tis|oferta|promo[çc]|imperd[íi]vel|liquida|desconto|barat|melhor\s*pre[çc]o|whats\s*app|https?:\/\/|www\./i
const TITULO_MAX = 60

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
  // termo mandado da aba "Em alta" pra aba "Pesquisa de mercado"
  const [buscaMercado, setBuscaMercado] = useState('')
  // categoria mandada de "Categorias em alta" pra "Em alta"
  const [categoriaAlta, setCategoriaAlta] = useState('')

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
        <button className={view === 'vendidos' ? 'tab on' : 'tab'} onClick={() => setView('vendidos')}>Mais vendidos</button>
        <button className={view === 'subindo' ? 'tab on' : 'tab'} onClick={() => setView('subindo')}>Em alta</button>
        <button className={view === 'categorias' ? 'tab on' : 'tab'} onClick={() => setView('categorias')}>Categorias em alta</button>
        <button className={view === 'publicar' ? 'tab on' : 'tab'} onClick={() => setView('publicar')}>Publicar anúncio</button>
        <button className={view === 'vantagens' ? 'tab on' : 'tab'} onClick={() => setView('vantagens')}>Vantagens no ML</button>
      </nav>

      {view === 'publicar' ? (
        <Publicar status={status} />
      ) : view === 'vantagens' ? (
        <Vantagens />
      ) : view === 'categorias' ? (
        <CategoriasAlta onVerProdutos={(catId) => { setCategoriaAlta(catId); setView('vendidos') }} />
      ) : view === 'subindo' ? (
        <ProdutosSubindo
          onPesquisar={(termo) => { setBuscaMercado(termo); setView('mercado') }}
          onVerCategoria={(catId) => { setCategoriaAlta(catId); setView('vendidos') }}
        />
      ) : view === 'vendidos' ? (
        <MaisVendidos
          categoriaInicial={categoriaAlta}
          onPesquisar={(termo) => { setBuscaMercado(termo); setView('mercado') }}
        />
      ) : view === 'mercado' ? (
        <Mercado inicial={buscaMercado} />
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

// Gráfico de visitas dia a dia (nó 2515:127 do Figma). SVG puro, sem
// biblioteca: são no máximo 91 pontos e o desenho é uma área + uma linha.
// A série já vem do servidor com os dias faltantes preenchidos com zero e em
// ordem cronológica — o endpoint do ML omite dia sem visita e devolve os
// pontos fora de ordem, então isso é resolvido lá.
function GraficoVisitas({ serie, dias, tom = 'neutro' }) {
  const L = 640, A = 170            // viewBox: o SVG escala pra largura do card
  const base = A - 18               // sobra embaixo pros números do eixo
  const n = serie?.length || 0
  if (n < 2) return <div className="hint">Sem série de visitas para desenhar.</div>

  const max = Math.max(...serie, 1)
  const x = (i) => (i / (n - 1)) * L
  const y = (v) => base - (v / max) * (base - 6)

  const pontos = serie.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const linha = 'M' + pontos.join(' L')
  const area = `${linha} L${L},${base} L0,${base} Z`

  // rótulos do eixo: de 7 em 7 dias pra não embolar
  const passo = dias >= 90 ? 10 : dias >= 60 ? 7 : 5
  const marcas = []
  for (let i = 0; i < n; i += passo) marcas.push(i)
  if (marcas[marcas.length - 1] !== n - 1) marcas.push(n - 1)

  return (
    <svg className={'graf ' + tom} viewBox={`0 0 ${L} ${A}`} preserveAspectRatio="none" role="img"
      aria-label={`Visitas por dia nos últimos ${dias} dias`}>
      {/* linhas de grade */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} className="graf-grade" x1="0" x2={L} y1={6 + f * (base - 6)} y2={6 + f * (base - 6)} />
      ))}
      <path className="graf-area" d={area} />
      <path className="graf-linha" d={linha} />
      {/* eixo dos dias */}
      <line className="graf-eixo" x1="0" x2={L} y1={base} y2={base} />
      {marcas.map((i) => (
        <g key={i}>
          <line className="graf-tick" x1={x(i)} x2={x(i)} y1={base} y2={base + 4} />
          <text className="graf-dia" x={x(i)} y={A - 3} textAnchor="middle">{i + 1}</text>
        </g>
      ))}
    </svg>
  )
}

// ===========================================================================
// EM ALTA — o que está SUBINDO no Mercado Livre inteiro.
// ===========================================================================
// Diferente de "Mais vendidos", que é a ordem de venda que o ML publica: aqui
// a ordem é de CRESCIMENTO. Vem da varredura das ~476 categorias, que mede as
// visitas diárias dos produtos do topo de cada uma — a lista é o que sobrou
// depois de filtrar só os que estão subindo com tráfego que sustente.
function ProdutosSubindo({ onPesquisar, onVerCategoria }) {
  const [rel, setRel] = useState(null)
  const [busca, setBusca] = useState('')
  const [secao, setSecao] = useState('todas')
  const [poucosVend, setPoucosVend] = useState(false)
  const [confiavel, setConfiavel] = useState(false)
  const [ordem, setOrdem] = useState('score')
  const [limite, setLimite] = useState(24)

  useEffect(() => {
    fetch('/api/produtos-em-alta').then((r) => r.json()).then(setRel).catch(() => setRel({ erro: true }))
  }, [])

  const secoes = useMemo(() => {
    if (!rel?.produtos) return []
    const s = new Set(rel.produtos.map((p) => p.categoria?.path?.split(' > ')[0]).filter(Boolean))
    return [...s].sort()
  }, [rel])

  const lista = useMemo(() => {
    if (!rel?.produtos) return []
    let l = rel.produtos
    if (secao !== 'todas') l = l.filter((p) => p.categoria?.path?.startsWith(secao))
    if (poucosVend) l = l.filter((p) => (p.n_vend ?? 99) <= 5)
    if (confiavel) l = l.filter((p) => !p.amostra_fragil)
    const t = busca.trim().toLowerCase()
    if (t) l = l.filter((p) => (p.nome || '').toLowerCase().includes(t) || (p.categoria?.path || '').toLowerCase().includes(t))
    const chave = (p) => (ordem === 'variacao' ? p.variacao : ordem === 'visitas' ? p.visitas_dia : p.score)
    return [...l].sort((a, b) => chave(b) - chave(a))
  }, [rel, secao, poucosVend, confiavel, busca, ordem])

  if (!rel) return <p className="spin">Lendo os produtos em alta…</p>
  if (rel.erro) return <div className="card"><div className="hint">Não consegui ler o relatório.</div></div>
  if (rel.vazio) {
    return (
      <>
        <div className="eyebrow">Crescimento real de visitas</div>
        <h1>Em alta</h1>
        <div className="card connect-box">
          <div className="big-ic">📈</div>
          <h2 style={{ justifyContent: 'center' }}>O relatório ainda não foi gerado</h2>
          <p className="sub" style={{ margin: '0 auto' }}>
            Esta lista sai da varredura das categorias — milhares de chamadas à API, não dá pra fazer
            na abertura da tela. Rode uma vez: <code>{rel.comando}</code>
          </p>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="eyebrow">Crescimento de visitas · {rel.produtos_medidos} produtos medidos em {rel.categorias_varridas} categorias</div>
      <h1>Em alta</h1>
      <p className="sub">
        Os produtos que <b>mais cresceram em procura</b> no Mercado Livre inteiro, não os que mais vendem.
        Só entram os que estão <b>subindo</b> e têm tráfego que sustente a conclusão — sem isso, sair de 1
        para 4 visitas viraria “+300%” e lideraria a lista.
      </p>

      <div className="card">
        <h2><span className="n">1</span> Filtrar</h2>
        <div className="row2">
          <div className="field">
            <label className="plain">Seção</label>
            <select value={secao} onChange={(e) => { setSecao(e.target.value); setLimite(24) }}>
              <option value="todas">Todas ({rel.total})</option>
              {secoes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="plain">Procurar</label>
            <input placeholder="nome do produto ou categoria" value={busca} onChange={(e) => { setBusca(e.target.value); setLimite(24) }} />
          </div>
        </div>
        <div className="cat-ordem" style={{ marginBottom: 10 }}>
          {[
            { id: 'score', label: 'Melhor combinação' },
            { id: 'variacao', label: 'Maior crescimento %' },
            { id: 'visitas', label: 'Mais visitas/dia' },
          ].map((o) => (
            <button key={o.id} type="button" className={ordem === o.id ? 'on' : ''} onClick={() => setOrdem(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={poucosVend} onChange={(e) => { setPoucosVend(e.target.checked); setLimite(24) }} />
          <span>Só com até 5 vendedores <i>(dá pra brigar com conta nova)</i></span>
        </label>
        <label className="check">
          <input type="checkbox" checked={confiavel} onChange={(e) => { setConfiavel(e.target.checked); setLimite(24) }} />
          <span>Só medições confiáveis <i>(esconde produto com muito vendedor, onde a amostra é frágil)</i></span>
        </label>
      </div>

      <div className="card">
        <h2>📈 {lista.length} produtos subindo <span className="pill">janela {rel.janela_dias} dias</span></h2>
        <div className="hint" style={{ marginBottom: 12 }}>
          A ordem “melhor combinação” pesa 55% o tamanho da procura e 45% a força do crescimento — um
          produto de 4.000 visitas/dia crescendo 60% vale mais que um de 40 crescendo 200%.
        </div>
        <div className="alta-grid">
          {lista.slice(0, limite).map((p, i) => (
            <CardAlta
              key={`${p.tipo}-${p.id}`}
              it={{
                ...p,
                // nesta aba a posição do card é a do RANKING DE CRESCIMENTO;
                // a posição no ranking de venda da categoria vai no rodapé
                posicao: i + 1,
                oficiais: p.oficiais,
                catalogo: p.tipo !== 'USER_PRODUCT' || !!p.item_ids?.length,
                preco_min: p.preco,
                demanda: {
                  visitas_dia: p.visitas_dia,
                  variacao: p.variacao,
                  direcao: p.direcao,
                  serie: p.serie,
                  dias: rel.janela_dias,
                  dias_sem_visita: (p.serie || []).filter((n) => n === 0).length,
                },
              }}
              janelaInicial={rel.janela_dias}
              onPesquisar={onPesquisar}
              rodape={
                <button type="button" className="alta-cat" onClick={() => onVerCategoria(p.categoria.id)}>
                  #{p.posicao} em vendas · {p.categoria.path} ›
                </button>
              }
            />
          ))}
        </div>
        {lista.length > limite && (
          <button className="ghost" style={{ marginTop: 14 }} onClick={() => setLimite(limite + 24)}>
            Mostrar mais {Math.min(24, lista.length - limite)}
          </button>
        )}
      </div>

      {/* Produtos que praticamente não existiam no começo da janela: o
          percentual deles não tem base de comparação, então vão à parte,
          ordenados por tamanho. É onde aparece lançamento e viral. */}
      {rel.estreantes?.length > 0 && (
        <div className="card">
          <h2>✨ Estreantes <span className="pill">{rel.estreantes.length}</span></h2>
          <div className="hint" style={{ marginBottom: 12 }}>
            Quase não tinham visita no começo da janela e hoje têm muita — lançamento, viral ou anúncio
            novo. Ficam fora do ranking acima porque o percentual não teria base de comparação
            (sairiam com “+668.154%” e liderariam tudo). Aqui a ordem é o tamanho da procura de hoje.
          </div>
          <div className="alta-grid">
            {rel.estreantes.slice(0, 12).map((p, i) => (
              <CardAlta
                key={`e-${p.tipo}-${p.id}`}
                it={{
                  ...p,
                  posicao: i + 1,
                  catalogo: true,
                  preco_min: p.preco,
                  demanda: {
                    visitas_dia: p.visitas_dia,
                    variacao: null,
                    direcao: 'subindo',
                    serie: p.serie,
                    dias: rel.janela_dias,
                    dias_sem_visita: (p.serie || []).filter((n) => n === 0).length,
                  },
                }}
                janelaInicial={rel.janela_dias}
                onPesquisar={onPesquisar}
                rodape={
                  <button type="button" className="alta-cat" onClick={() => onVerCategoria(p.categoria.id)}>
                    #{p.posicao} em vendas · {p.categoria.path} ›
                  </button>
                }
              />
            ))}
          </div>
        </div>
      )}

      <footer>
        Crescimento medido comparando a metade recente da janela com a anterior, nas visitas diárias dos
        anúncios de cada produto. Visita mede procura, não venda. Em produto com muitos vendedores a
        medição é de uma amostra dos anúncios — use o filtro de medições confiáveis.
        Para atualizar: <code>npm run categorias</code>
      </footer>
    </>
  )
}

// ===========================================================================
// CATEGORIAS EM ALTA — qual seção do ML está esquentando.
// ===========================================================================
// Lê o relatório gerado por `npm run categorias`. Não calcula na hora de
// propósito: são milhares de chamadas à API, impossível numa abertura de tela.
const ORDENS = [
  { id: 'temperatura', label: 'Temperatura', desc: 'oportunidade + crescimento + folga de concorrência' },
  { id: 'visitas_por_100k_anuncios', label: 'Procura por oferta', desc: 'visitas/dia para cada 100 mil anúncios — o que separa quente de disputado' },
  { id: 'visitas_dia', label: 'Procura bruta', desc: 'visitas/dia somadas dos mais vendidos' },
  { id: 'crescimento', label: 'Crescimento', desc: 'quantos do topo estão subindo' },
  { id: 'folga', label: 'Menos concorrência', desc: 'menor média de vendedores por produto' },
  { id: 'avaliacoes', label: 'Venda acumulada', desc: 'avaliações somadas dos mais vendidos' },
]

function CategoriasAlta({ onVerProdutos }) {
  const [rel, setRel] = useState(null)
  const [erro, setErro] = useState(null)
  const [ordem, setOrdem] = useState('temperatura')
  const [nivel, setNivel] = useState('todos') // todos | secoes | subcategorias
  const [busca, setBusca] = useState('')
  const [aberta, setAberta] = useState(null)

  useEffect(() => {
    fetch('/api/categorias-alta')
      .then((r) => r.json())
      .then(setRel)
      .catch(() => setErro('Não consegui ler o relatório.'))
  }, [])

  const lista = useMemo(() => {
    if (!rel?.categorias) return []
    let l = rel.categorias
    if (nivel === 'secoes') l = l.filter((c) => c.nivel === 1)
    if (nivel === 'subcategorias') l = l.filter((c) => c.nivel > 1)
    const t = busca.trim().toLowerCase()
    if (t) l = l.filter((c) => (c.path || c.nome).toLowerCase().includes(t))
    const chave = (c) => {
      if (ordem === 'crescimento') return c.amostra ? (c.subindo - c.caindo) / c.amostra : -9
      if (ordem === 'folga') return -(c.vendedores_medio ?? 999)
      return c[ordem] ?? -1
    }
    return [...l].sort((a, b) => chave(b) - chave(a))
  }, [rel, ordem, nivel, busca])

  if (erro) return <div className="card"><div className="hint">{erro}</div></div>
  if (!rel) return <p className="spin">Lendo o relatório de categorias…</p>

  if (rel.vazio) {
    return (
      <>
        <div className="eyebrow">Oferta, procura e crescimento por categoria</div>
        <h1>Categorias em alta</h1>
        <div className="card connect-box">
          <div className="big-ic">📊</div>
          <h2 style={{ justifyContent: 'center' }}>O relatório ainda não foi gerado</h2>
          <p className="sub" style={{ margin: '0 auto' }}>
            Esta tela lê um relatório pronto — varrer todas as categorias são milhares de chamadas
            à API do Mercado Livre, não dá pra fazer na abertura da página. Rode uma vez:
          </p>
          <p className="sub" style={{ margin: '12px auto 0' }}><code>{rel.comando}</code></p>
        </div>
      </>
    )
  }

  const ordemAtiva = ORDENS.find((o) => o.id === ordem)
  const oportunidades = rel.categorias.filter((c) => c.leitura === 'oportunidade').slice(0, 5)

  return (
    <>
      <div className="eyebrow">Oferta, procura e crescimento · {rel.total_analisadas} categorias analisadas</div>
      <h1>Categorias em alta</h1>
      <p className="sub">
        Onde tem <b>muita procura para pouca oferta</b>. Categoria campeã de venda costuma ser campeã de
        concorrência — por isso a régua principal não é volume, é <b>procura por anúncio existente</b>.
      </p>

      {oportunidades.length > 0 && (
        <div className="card">
          <h2>🎯 As 5 melhores apostas</h2>
          <div className="hint" style={{ marginBottom: 10 }}>
            Muita visita por anúncio, crescendo e sem multidão de vendedores.
          </div>
          <ol className="cat-top">
            {oportunidades.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setAberta(aberta === c.id ? null : c.id)}>
                  <span className="n">{c.temperatura}</span>
                  <span className="txt">
                    <b>{c.nome}</b>
                    <span className="p">{c.path}</span>
                  </span>
                  <span className="v">{fmtNum(c.visitas_por_100k_anuncios)} <i>vis/dia por 100k anúncios</i></span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="card">
        <h2><span className="n">1</span> Como ordenar</h2>
        <div className="cat-ordem">
          {ORDENS.map((o) => (
            <button key={o.id} type="button" className={ordem === o.id ? 'on' : ''} onClick={() => setOrdem(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
        <div className="hint">{ordemAtiva?.desc}</div>

        <div className="row2" style={{ marginTop: 14 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="plain">Nível</label>
            <select value={nivel} onChange={(e) => setNivel(e.target.value)}>
              <option value="todos">Tudo ({rel.categorias.length})</option>
              <option value="secoes">Só as seções ({rel.categorias.filter((c) => c.nivel === 1).length})</option>
              <option value="subcategorias">Só subcategorias ({rel.categorias.filter((c) => c.nivel > 1).length})</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="plain">Procurar categoria</label>
            <input placeholder="ex: brinquedo" value={busca} onChange={(e) => setBusca(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>📋 {lista.length} categorias <span className="pill">janela {rel.janela_dias} dias</span></h2>
        <div className="hint" style={{ marginBottom: 12 }}>
          Procura medida nos {rel.top_por_categoria} mais vendidos de cada categoria — é uma amostra com a
          mesma régua pra todas, serve pra comparar entre si, não como volume absoluto da categoria inteira.
        </div>

        <div className="cat-lista">
          {lista.map((c, i) => (
            <CategoriaLinha
              key={c.id}
              c={c}
              pos={i + 1}
              aberta={aberta === c.id}
              onToggle={() => setAberta(aberta === c.id ? null : c.id)}
              onVerProdutos={onVerProdutos}
            />
          ))}
        </div>
      </div>

      {rel.sem_ranking?.length > 0 && (
        <div className="card">
          <h2>Sem ranking publicado</h2>
          <div className="hint">
            O Mercado Livre não publica lista de mais vendidos para {rel.sem_ranking.length} categorias —
            elas ficam de fora da comparação. Ex.: {rel.sem_ranking.slice(0, 6).map((c) => c.nome).join(' · ')}
          </div>
        </div>
      )}

      <footer>
        Oferta vem do total de anúncios que o próprio ML declara na categoria. Procura e crescimento saem das
        visitas diárias dos produtos do topo do ranking de mais vendidos. Venda acumulada é o total de
        avaliações desses produtos — só quem compra avalia, então é um piso, nunca o número exato.
        Para atualizar: <code>npm run categorias</code>
      </footer>
    </>
  )
}

const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'))

// Crescimento acima de ~5x fica ilegivel em porcentagem ("+668154%"), entao
// vira multiplicador: "67x mais" diz a mesma coisa e da pra ler.
const fmtVariacao = (v) => {
  if (v == null) return ''
  if (v > 500) return `${Math.round(1 + v / 100).toLocaleString('pt-BR')}× mais`
  return `${v > 0 ? '+' : ''}${v}%`
}

// Uma linha da lista de categorias: resumo sempre visível, detalhe ao clicar.
function CategoriaLinha({ c, pos, aberta, onToggle, onVerProdutos }) {
  const tom = c.direcao === 'subindo' ? 'sobe' : c.direcao === 'caindo' ? 'cai' : 'neutro'
  const barra = c.amostra
    ? { s: (c.subindo / c.amostra) * 100, e: (c.estavel / c.amostra) * 100, c: (c.caindo / c.amostra) * 100 }
    : null

  return (
    <div className={'cat-linha' + (aberta ? ' aberta' : '')}>
      <button type="button" className="cat-cab" onClick={onToggle}>
        <span className="pos">{pos}</span>
        <span className={'temp t' + Math.min(9, Math.floor((c.temperatura || 0) / 10))}>{c.temperatura}</span>
        <span className="nome">
          <b>{c.nome}</b>
          <span className="p">{c.nivel > 1 ? c.path : `${c.filhas} subcategorias`}</span>
        </span>
        <span className="nums">
          <span className="n1">{fmtNum(c.visitas_dia)} <i>vis/dia</i></span>
          <span className="n2">{fmtNum(c.visitas_por_100k_anuncios)} <i>por 100k</i></span>
        </span>
        <span className={'leitura ' + tom}>{c.leitura}</span>
      </button>

      {aberta && (
        <div className="cat-det">
          <div className="cat-grade">
            <div><span className="k">Anúncios na categoria</span><span className="v">{fmtNum(c.anuncios)}</span></div>
            <div><span className="k">Visitas/dia (topo)</span><span className="v">{fmtNum(c.visitas_dia)}</span></div>
            <div><span className="k">Procura por 100k anúncios</span><span className="v destaque">{fmtNum(c.visitas_por_100k_anuncios)}</span></div>
            <div><span className="k">Avaliações somadas</span><span className="v">{fmtNum(c.avaliacoes)}</span></div>
            <div><span className="k">Preço mediano</span><span className="v">{c.preco_mediano != null ? money(c.preco_mediano) : '—'}</span></div>
            <div><span className="k">Vendedores por produto</span><span className="v">{c.vendedores_medio ?? '—'}</span></div>
            <div><span className="k">Com loja oficial</span><span className="v">{c.oficiais_pct != null ? `${c.oficiais_pct}%` : '—'}</span></div>
            <div><span className="k">Produtos medidos</span><span className="v">{c.amostra}</span></div>
          </div>

          {barra && (
            <div className="cat-barra-bloco">
              <div className="cat-barra">
                <span className="s" style={{ width: `${barra.s}%` }} />
                <span className="e" style={{ width: `${barra.e}%` }} />
                <span className="c" style={{ width: `${barra.c}%` }} />
              </div>
              <div className="hint">
                Dos {c.amostra} mais vendidos: <b>{c.subindo} subindo</b> · {c.estavel} estáveis ·{' '}
                <b>{c.caindo} caindo</b>
                {c.variacao != null && ` — a categoria como um todo ${c.direcao === 'subindo' ? 'subiu' : c.direcao === 'caindo' ? 'caiu' : 'variou'} ${Math.abs(c.variacao)}% na janela.`}
              </div>
            </div>
          )}

          {c.serie?.length > 1 && (
            <div className="cat-graf">
              <div className="alta-graf-topo">
                <span className="t">Visitas somadas do topo · últimos {c.janela_dias} dias</span>
                {c.variacao != null && (
                  <span className={'v ' + tom}>
                    {c.variacao > 0 ? '▲' : c.variacao < 0 ? '▼' : '='} {Math.abs(c.variacao)}%
                  </span>
                )}
              </div>
              <GraficoVisitas serie={c.serie} dias={c.janela_dias} tom={tom} />
            </div>
          )}

          {c.termos?.length > 0 && (
            <div>
              <div className="hint" style={{ marginBottom: 6 }}>Mais buscados nesta categoria:</div>
              <div className="termo-chips">
                {c.termos.map((t) => <span key={t} className="termo-chip estatico">{t}</span>)}
              </div>
            </div>
          )}

          <div className="cat-acoes">
            <button type="button" className="alta-btn cheio" onClick={() => onVerProdutos(c.id)}>
              Ver os produtos desta categoria
            </button>
            {c.permalink && (
              <a className="alta-btn" href={c.permalink} target="_blank" rel="noreferrer">Abrir no ML</a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Card de um produto do ranking (nó 2515:103 do Figma). Cada card tem a sua
// própria janela de gráfico: trocar 30/60/90 aqui refaz só a série DESTE
// produto, sem recarregar a categoria inteira.
function CardAlta({ it, janelaInicial, onPesquisar, rodape = null }) {
  const [janela, setJanela] = useState(janelaInicial)
  const [dem, setDem] = useState(it.demanda)
  const [carregando, setCarregando] = useState(false)

  // a categoria recarregou com outra janela: volta a acompanhar o padrão
  useEffect(() => {
    setJanela(janelaInicial)
    setDem(it.demanda)
  }, [janelaInicial, it.demanda])

  async function trocar(dias) {
    if (dias === janela) return
    setJanela(dias)
    if (!it.item_ids?.length) return
    setCarregando(true)
    try {
      const d = await fetch(
        '/api/serie-visitas?itens=' + encodeURIComponent(it.item_ids.join(',')) + '&dias=' + dias
      ).then((r) => r.json())
      if (!d.erro) setDem(d)
    } catch { /* mantém o que já estava na tela */ }
    setCarregando(false)
  }

  const tom = dem?.direcao === 'subindo' ? 'sobe' : dem?.direcao === 'caindo' ? 'cai' : 'neutro'

  return (
    <div className="alta-card">
      <div className="alta-pos">#{it.posicao}</div>
      <div className="alta-pic">
        {it.thumbnail ? <img src={it.thumbnail} alt="" /> : <span className="alta-pic-vazia">Imagem do produto</span>}
      </div>
      <div className="alta-body">
        <div className="alta-nome">
          {it.nome || (it.sem_dados ? 'Anúncio individual (o ML não abre os dados)' : 'Sem nome')}
        </div>
        {it.marca && <div className="alta-marca">{it.marca}</div>}

        <div className="alta-num">
          {it.preco_min != null ? <b>{money(it.preco_min)}</b> : <span className="alta-sem">preço não disponível</span>}
          {it.n_vend != null && (
            <span className={'alta-conc' + (it.n_vend > 30 ? ' muito' : it.n_vend <= 5 ? ' pouco' : '')}>
              {it.n_vend} {it.n_vend === 1 ? 'vendedor' : 'vendedores'}
            </span>
          )}
        </div>

        <div className="alta-sinais">
          {it.avaliacoes != null && (
            <span className="alta-sinal" title="Só quem comprou avalia — é um piso de quantas vendas o produto já teve.">
              <i className="pt" /> {it.avaliacoes.toLocaleString('pt-BR')} avaliações
              {it.nota != null && ` · ★ ${String(it.nota).replace('.', ',')}`}
            </span>
          )}
          {dem && (
            <span className={'alta-sinal forte ' + tom}>
              <i className="pt" /> {dem.visitas_dia.toLocaleString('pt-BR')} visitas/dia
              {dem.direcao === 'subindo' && ` · subindo${dem.variacao != null ? ` ${fmtVariacao(dem.variacao)}` : ''}`}
              {dem.direcao === 'caindo' && ` · caindo ${dem.variacao}%`}
              {dem.direcao === 'estavel' && ' · estável'}
              {dem.direcao === 'pouco movimento' && ' · pouco movimento'}
            </span>
          )}
          {it.movimento && (
            <span className={'alta-sinal ' + (it.movimento.novo ? 'novo' : it.movimento.delta > 0 ? 'sobe' : it.movimento.delta < 0 ? 'cai' : '')}>
              {it.movimento.novo
                ? '✨ novo no ranking'
                : it.movimento.delta > 0
                  ? `▲ subiu ${it.movimento.delta} (era #${it.movimento.antes})`
                  : it.movimento.delta < 0
                    ? `▼ caiu ${-it.movimento.delta} (era #${it.movimento.antes})`
                    : '= mesma posição'}
            </span>
          )}
          {it.oficiais > 0 && <span className="alta-alerta">⚠ {it.oficiais} loja oficial vendendo</span>}
          {it.amostra_fragil && (
            <span className="alta-tag" title="Medimos as visitas de poucos anúncios; com muitos vendedores a tendência pode refletir só esses anúncios.">
              ◑ {it.n_vend} vendedores — tendência medida numa amostra
            </span>
          )}
          {!it.catalogo && !it.sem_dados && <span className="alta-tag">anúncio próprio de vendedor</span>}
        </div>

        {/* ── Gráfico de visitas dia a dia ── */}
        {dem?.serie?.length > 1 && (
          <div className="alta-graf">
            <div className="alta-graf-topo">
              <span className="t">Visitas · últimos {janela} dias</span>
              {dem.variacao != null && dem.direcao !== 'pouco movimento' && (
                <span className={'v ' + tom}>
                  {dem.variacao > 0 ? '▲' : dem.variacao < 0 ? '▼' : '='}{' '}
                  {dem.variacao > 500 ? fmtVariacao(dem.variacao) : `${Math.abs(dem.variacao)}%`}
                </span>
              )}
            </div>
            <div className="segmented mini">
              {[30, 60, 90].map((d) => (
                <button key={d} type="button" className={janela === d ? 'on' : ''} onClick={() => trocar(d)}>
                  {d} dias
                </button>
              ))}
            </div>
            <div className={'alta-graf-caixa' + (carregando ? ' carregando' : '')}>
              <GraficoVisitas serie={dem.serie} dias={dem.dias} tom={tom} />
            </div>
            <div className="alta-graf-nota">
              Um ponto por dia, até ontem — hoje ainda está correndo.
              {dem.dias_sem_visita > 0 &&
                ` ${dem.dias_sem_visita} ${dem.dias_sem_visita === 1 ? 'dia ficou' : 'dias ficaram'} sem nenhuma visita.`}
            </div>
          </div>
        )}

        {rodape}

        <div className="alta-acoes">
          {it.nome && (
            <button type="button" className="alta-btn" onClick={() => onPesquisar(it.nome)}>Pesquisar</button>
          )}
          <a className="alta-btn cheio" href={it.url} target="_blank" rel="noreferrer">Ver no ML</a>
        </div>
      </div>
    </div>
  )
}

// ===========================================================================
// MAIS VENDIDOS — o caminho inverso: parte do que o ML já vende bem.
// ===========================================================================
// O ranking vem de /highlights: é ranking de VENDA (BEST_SELLER), montado pelo
// próprio ML. Não é ranking de crescimento — um campeão de vendas pode estar
// esfriando, e é por isso que cada card mostra também a tendência de visitas.
// Quem ordena por crescimento é a aba "Em alta".
// Escolha a categoria FOLHA: na raiz o topo é o campeão de venda do Brasil
// inteiro, com centenas de vendedores.
function MaisVendidos({ onPesquisar, categoriaInicial = '' }) {
  const [raizes, setRaizes] = useState([])
  const [raiz, setRaiz] = useState('')
  const [filhas, setFilhas] = useState([])
  const [filha, setFilha] = useState('')
  const [dados, setDados] = useState(null)
  const [busy, setBusy] = useState(false)
  const [termosSite, setTermosSite] = useState([])
  const [janela, setJanela] = useState(30) // janela das visitas: 30, 60 ou 90 dias

  const catAberta = useRef('')

  useEffect(() => {
    fetch('/api/categorias').then((r) => r.json()).then((d) => setRaizes(d.filhas || [])).catch(() => {})
    fetch('/api/termos-alta').then((r) => r.json()).then((d) => setTermosSite(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  // veio de "Categorias em alta": abre direto o ranking daquela categoria e
  // deixa os dois seletores coerentes com ela
  useEffect(() => {
    const alvo = (categoriaInicial || '').trim()
    if (!alvo || catAberta.current === alvo) return
    // espera a lista de seções chegar, senão não dá pra descobrir a seção
    // desta categoria e os dois seletores ficariam vazios
    if (!raizes.length) return
    catAberta.current = alvo
    ;(async () => {
      try {
        const info = await fetch('/api/categorias?pai=' + encodeURIComponent(alvo)).then((r) => r.json())
        // se a categoria tem pai, carrega as irmãs pra o segundo seletor
        const raizId = info?.path?.split(' > ')?.[0] || null
        const raizObj = raizes.find((r) => r.name === raizId)
        if (raizObj) {
          setRaiz(raizObj.id)
          const f = await fetch('/api/categorias?pai=' + encodeURIComponent(raizObj.id)).then((r) => r.json())
          setFilhas(f.filhas || [])
          setFilha(f.filhas?.some((x) => x.id === alvo) ? alvo : '')
        }
      } catch { /* segue e carrega o ranking mesmo assim */ }
      carregar(alvo)
    })()
  }, [categoriaInicial, raizes])

  async function escolherRaiz(id) {
    setRaiz(id); setFilha(''); setFilhas([]); setDados(null)
    if (!id) return
    try {
      const d = await fetch('/api/categorias?pai=' + encodeURIComponent(id)).then((r) => r.json())
      setFilhas(d.filhas || [])
    } catch { setFilhas([]) }
  }

  async function carregar(catId, dias = janela) {
    if (!catId) return
    setBusy(true); setDados(null)
    try {
      setDados(await fetch(
        '/api/em-alta?categoria=' + encodeURIComponent(catId) + '&dias=' + dias
      ).then((r) => r.json()))
    } catch {
      setDados({ erro: 'falhou', itens: [] })
    }
    setBusy(false)
  }

  // trocar a janela recarrega a categoria que está na tela
  function trocarJanela(dias) {
    setJanela(dias)
    const atual = filha || raiz
    if (atual && dados) carregar(atual, dias)
  }

  const itens = dados?.itens || []

  return (
    <>
      <div className="eyebrow">Ranking de venda publicado pelo Mercado Livre</div>
      <h1>Mais vendidos</h1>
      <p className="sub">
        Aqui é o contrário da calculadora: em vez de partir do seu produto, parte do que o ML{' '}
        <b>já está vendendo bem</b>. A ordem é de <b>venda</b>, não de crescimento — por isso um #1 pode
        aparecer com as visitas caindo. Quem ordena por crescimento é a aba <b>Em alta</b>.
      </p>

      <div className="card">
        <h2><span className="n">1</span> Escolha a categoria</h2>
        <div className="row2">
          <div className="field">
            <label>Seção</label>
            <select value={raiz} onChange={(e) => escolherRaiz(e.target.value)}>
              <option value="">— escolha —</option>
              {raizes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Categoria</label>
            <select
              value={filha}
              disabled={!filhas.length}
              onChange={(e) => { setFilha(e.target.value); carregar(e.target.value) }}
            >
              <option value="">{filhas.length ? '— escolha —' : 'escolha a seção primeiro'}</option>
              {filhas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <div className="hint">
          Prefira a categoria de dentro. Na seção inteira o topo costuma ter centenas de vendedores —
          briga difícil pra conta nova.
        </div>
        {raiz && (
          <button className="ghost" style={{ marginTop: 10 }} onClick={() => carregar(raiz)}>
            Ver o ranking da seção inteira mesmo assim
          </button>
        )}

        {/* janela das visitas — mesma régua do termômetro de procura */}
        <div className="field" style={{ marginTop: 16, marginBottom: 0 }}>
          <label className="plain">Janela das visitas</label>
          <div className="segmented">
            {[30, 60, 90].map((d) => (
              <button
                key={d}
                type="button"
                className={janela === d ? 'on' : ''}
                onClick={() => trocarJanela(d)}
              >
                {d} dias
              </button>
            ))}
          </div>
          <div className="hint">
            Janela curta reage rápido a novidade; janela longa é mais estável e menos sujeita a
            pico de um dia só. O ranking de mais vendidos não muda — só a leitura de procura.
          </div>
        </div>
      </div>

      {!dados && !busy && termosSite.length > 0 && (
        <div className="card">
          <h2>🔥 Mais buscados no ML hoje</h2>
          <div className="hint" style={{ marginBottom: 10 }}>
            O que o Brasil está digitando na busca agora. Clique pra pesquisar no app.
          </div>
          <div className="termo-chips">
            {termosSite.map((t) => (
              <button key={t.termo} type="button" className="termo-chip" onClick={() => onPesquisar(t.termo)}>
                {t.termo}
              </button>
            ))}
          </div>
        </div>
      )}

      {busy && <p className="spin">Puxando o ranking de mais vendidos…</p>}

      {dados?.termos?.length > 0 && (
        <div className="card">
          <h2>🔥 Mais buscados nesta categoria</h2>
          <div className="termo-chips">
            {dados.termos.map((t) => (
              <button key={t.termo} type="button" className="termo-chip" onClick={() => onPesquisar(t.termo)}>
                {t.termo}
              </button>
            ))}
          </div>
        </div>
      )}

      {dados && !busy && (
        dados.vazio || !itens.length ? (
          <div className="card">
            <div className="hint">
              O Mercado Livre não publica ranking de mais vendidos para esta categoria. Tente outra —
              ou veja o da seção inteira.
            </div>
          </div>
        ) : (
          <div className="card">
            <h2>
              🏆 Mais vendidos {dados.categoria?.nome ? `em ${dados.categoria.nome}` : ''}
              <span className="pill">{itens.length} posições</span>
            </h2>
            {dados.categoria?.path && <div className="hint" style={{ marginBottom: 4 }}>{dados.categoria.path}</div>}
            <div className="hint" style={{ marginBottom: 12 }}>
              {dados.historico?.comparado_com
                ? <>Movimento no ranking comparado com <b>{dados.historico.comparado_com.split('-').reverse().join('/')}</b>. Visitas dos últimos {dados.historico.janela_visitas} dias.</>
                : <>O Mercado Livre não publica histórico — <b>eu começo a guardar hoje</b>. Amanhã esta tela já mostra quem subiu e quem caiu. Visitas dos últimos {dados.historico?.janela_visitas || 30} dias.</>}
            </div>
            <div className="alta-grid">
              {itens.map((it) => (
                <CardAlta
                  key={`${it.tipo}-${it.id}`}
                  it={it}
                  janelaInicial={janela}
                  onPesquisar={onPesquisar}
                />
              ))}
            </div>
          </div>
        )
      )}

      <footer>
        Ranking de mais vendidos publicado pelo próprio Mercado Livre, buscado na hora (guardado por 1 hora).
        A quantidade vendida por anúncio o ML não abre pra ninguém: <b>avaliações</b> são o piso de quantas vendas
        o produto já teve (só quem compra avalia) e <b>visitas/dia</b> mostram se está esquentando ou esfriando agora.
        O ranking não conhece o seu custo: produto em alta com muitos vendedores costuma ser armadilha pra conta nova.
      </footer>
    </>
  )
}

// `inicial` chega quando a pessoa clica em "Pesquisar" num produto da aba
// "Em alta" — a busca já dispara sozinha com o nome dele.
function Mercado({ inicial = '' }) {
  const [q, setQ] = useState(inicial)
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState(null)
  const [msg, setMsg] = useState(null)
  const jaBuscou = useRef('')

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

  // veio da aba "Em alta": pesquisa sozinho (uma vez por termo)
  useEffect(() => {
    const t = (inicial || '').trim()
    if (t && jaBuscou.current !== t) {
      jaBuscou.current = t
      setQ(t)
      buscar(t)
    }
  }, [inicial])

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

// Traduz o resultado do termômetro (visitas) em um estado visual do card:
//   verde    = procura em alta, com tráfego que sustenta a conclusão
//   laranja  = atenção (procura parada, ou subindo com pouca visita pra confiar)
//   vermelho = procura ruim (em queda, ou quase ninguém procurando)
// O percentual só aparece quando há tráfego: sair de 1 pra 4 visitas vira
// "+300%" e passa uma ideia errada de produto bombando.
function nivelProcura(t) {
  const semTrafego = t.sinal_fraco || t.total < 15

  if (t.direcao === 'caindo') {
    return {
      tone: 'down', emo: '📉', txt: 'Procura em QUEDA', mostrarPct: !semTrafego,
      nota: semTrafego
        ? '⚠️ Poucas visitas na janela — a queda é uma pista, não uma certeza.'
        : 'Menos gente procurando este produto que na metade anterior da janela.',
    }
  }
  if (semTrafego) {
    // pouquíssima visita: não importa a direção, ninguém está procurando isso
    return {
      tone: 'low', emo: '🔻', txt: 'Procura BAIXA', mostrarPct: false,
      nota: `Só ${t.total} visita${t.total === 1 ? '' : 's'} em ${t.dias} dias somando todos os anúncios — procura fraca demais pra medir tendência.`,
    }
  }
  if (t.direcao === 'estavel') {
    return {
      tone: 'flat', emo: '➖', txt: 'Procura ESTÁVEL', mostrarPct: true,
      nota: 'Sem crescimento na janela — dá pra vender, mas não espere disparada.',
    }
  }
  return {
    tone: 'up', emo: '📈', txt: 'Procura em ALTA', mostrarPct: true,
    nota: 'Mais gente procurando que na metade anterior da janela.',
  }
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
  // A lista "Resultados da busca" só aparece quando a PESSOA pesquisou uma
  // categoria pelo nome. No preenchimento automático (produto do carrossel ou
  // do banco) a categoria já vem escolhida — a lista só polui a tela.
  const [catsBusca, setCatsBusca] = useState(false)
  const [predicting, setPredicting] = useState(false)
  const [comp, setComp] = useState(null)
  const [compIdx, setCompIdx] = useState(0) // qual candidato "é o seu produto"
  const [res, setRes] = useState(null)
  const [anuncios, setAnuncios] = useState({ loading: false, data: null })
  const [tendencia, setTendencia] = useState({ loading: false, data: null })
  const [janelaDias, setJanelaDias] = useState(60) // janela do termômetro de procura
  const [anuncioPrep, setAnuncioPrep] = useState({ loading: false, data: null })
  // peso/medidas da embalagem lidos do anúncio do ML (produto do carrossel)
  const [pacoteMl, setPacoteMl] = useState({ loading: false, data: null })
  // de onde veio o que está nos campos do passo 3: null | 'banco' | 'anuncio' | 'manual'.
  // O que veio do BANCO ou foi digitado à MÃO nunca é sobrescrito sozinho.
  const [fontePacote, setFontePacote] = useState({ peso: null, medidas: null })
  const fontePacoteRef = useRef(fontePacote) // leitura dentro de callbacks async
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

  function marcarFonte(patch) {
    fontePacoteRef.current = { ...fontePacoteRef.current, ...patch }
    setFontePacote(fontePacoteRef.current)
  }
  // Peso e medidas: digitar à mão vira a fonte da verdade (o auto-preenchimento
  // do anúncio não passa por cima depois).
  const updPacote = (k) => (e) => {
    marcarFonte(k === 'pesoKg' ? { peso: 'manual' } : { medidas: 'manual' })
    upd(k)(e)
  }

  // Limpa TUDO que era do produto anterior — chamado ao pesquisar/puxar um novo,
  // pra a tela nunca misturar dados de dois produtos.
  function limparResultados() {
    setComp(null); setCompIdx(0)
    setCats([]); setCatsBusca(false)
    setRes(null); setErr(null)
    setAnuncios({ loading: false, data: null })
    setTendencia({ loading: false, data: null })
    setAnuncioPrep({ loading: false, data: null })
    setPacoteMl({ loading: false, data: null })
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
      // guardamos as sugestões (o caminho da categoria escolhida sai daqui),
      // mas sem mostrar a lista: isso aqui é preenchimento automático
      setCats(list)
      setCatsBusca(false)
      // o 1º candidato já vem selecionado no carrossel — puxa o pacote dele
      const cand0 = compD?.candidatos?.[0] || (compD?.matched ? compD : null)
      if (cand0) puxarPacoteMl(cand0)
      if (list.length) {
        aplicarCategoria(list[0].category_id, list[0].category_name)
      } else {
        // sem sugestão: zera a categoria em vez de deixar a do produto anterior
        // pendurada na tela (o campo e o "Categoria escolhida" leem daqui)
        aplicarCategoria('', '')
      }
    } catch {
      setCats([])
      setCatsBusca(false)
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

    if (!t) { setCats([]); setCatsBusca(false); setF((p) => ({ ...p, categoryId: '', categoryName: '' })); return }
    if (ehIdMlb(t)) { setCats([]); setCatsBusca(false); setF((p) => ({ ...p, categoryId: t, categoryName: '' })); return }

    setF((p) => ({ ...p, categoryId: '', categoryName: '' }))
    if (t.length < 3) { setCats([]); setCatsBusca(false); return }
    catTimer.current = setTimeout(async () => {
      setBuscandoCat(true)
      try {
        const d = await fetch('/api/buscar-categoria?q=' + encodeURIComponent(t)).then((r) => r.json())
        setCats(Array.isArray(d) ? d : [])
        setCatsBusca(true) // foi a pessoa que pesquisou: pode mostrar a lista
      } catch {
        setCats([])
        setCatsBusca(false)
      }
      setBuscandoCat(false)
    }, 350)
  }

  // Peso e medidas da EMBALAGEM do produto escolhido no carrossel: quem já
  // vende teve que declarar isso pro ML calcular o frete. Preenche o passo 3
  // sozinho — e a pessoa pode editar depois (ou o valor do banco tem prioridade).
  async function puxarPacoteMl(cand) {
    if (!cand?.catalog_id && !cand?.item_id) return
    setPacoteMl({ loading: true, data: null })
    try {
      const qs = new URLSearchParams()
      if (cand.catalog_id) qs.set('catalog_id', cand.catalog_id)
      if (cand.item_id) qs.set('item_id', cand.item_id)
      const d = await fetch('/api/pacote?' + qs.toString()).then((r) => r.json())
      const achou = d?.encontrado ? d : null
      setPacoteMl({ loading: false, data: achou })
      if (achou) aplicarPacote(achou, false)
    } catch {
      setPacoteMl({ loading: false, data: null })
    }
  }

  // Joga o pacote do anúncio nos campos. forcar = clique em "Usar estes dados"
  // (aí passa por cima até do que veio do banco / foi digitado).
  function aplicarPacote(p, forcar) {
    const fixo = (v) => ['banco', 'manual'].includes(v)
    const usarPeso = p.peso_kg != null && (forcar || !fixo(fontePacoteRef.current.peso))
    const temMedidas = p.altura_cm != null && p.largura_cm != null && p.comprimento_cm != null
    const usarMedidas = temMedidas && (forcar || !fixo(fontePacoteRef.current.medidas))
    if (!usarPeso && !usarMedidas) return
    setF((prev) => ({
      ...prev,
      pesoKg: usarPeso ? String(p.peso_kg) : prev.pesoKg,
      alt: usarMedidas ? String(p.altura_cm) : prev.alt,
      larg: usarMedidas ? String(p.largura_cm) : prev.larg,
      comp: usarMedidas ? String(p.comprimento_cm) : prev.comp,
    }))
    marcarFonte({
      ...(usarPeso ? { peso: 'anuncio' } : null),
      ...(usarMedidas ? { medidas: 'anuncio' } : null),
    })
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
    // o que o banco souber tem prioridade sobre o que vier do anúncio do ML
    marcarFonte({
      peso: peso != null ? 'banco' : null,
      medidas: (dim.altura_cm != null && dim.largura_cm != null && dim.comprimento_cm != null)
        ? 'banco'
        : null,
    })
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
      pesoKg: parseFloat(f.pesoKg) || null,          // passo 3 (banco, anúncio ou digitado)
      dimensoes: (f.alt && f.larg && f.comp) ? `${f.alt} × ${f.larg} × ${f.comp} cm` : null,
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
    // ...e o peso/medidas da embalagem que quem vende declarou pro ML
    puxarPacoteMl(cand)
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
            {catsBusca && cats.length > 0 && (
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
              <input type="number" step="0.01" value={f.pesoKg} onChange={updPacote('pesoKg')} />
            </div>
            {/* dimensions-row do design: cada medida com seu próprio rótulo */}
            <div className="field">
              <div className="row3">
                <div className="field">
                  <label className="plain">Altura (cm)</label>
                  <input type="number" placeholder="0" value={f.alt} onChange={updPacote('alt')} />
                </div>
                <div className="field">
                  <label className="plain">Largura (cm)</label>
                  <input type="number" placeholder="0" value={f.larg} onChange={updPacote('larg')} />
                </div>
                <div className="field">
                  <label className="plain">Comprimento (cm)</label>
                  <input type="number" placeholder="0" value={f.comp} onChange={updPacote('comp')} />
                </div>
              </div>
              <div className="hint">Sem as medidas eu calculo comissão e custo fixo, mas não consigo o frete real.</div>
            </div>

            {/* Pacote lido do anúncio do ML (produto escolhido no passo 2).
                Preenche sozinho quando os campos não vieram do banco nem foram
                digitados; sempre dá pra editar em cima ou trazer de volta. */}
            {pacoteMl.loading && (
              <div className="hint">Buscando peso e medidas no anúncio do Mercado Livre…</div>
            )}
            {pacoteMl.data && (
              <div className="ml-pack">
                <div className="ml-pack-txt">
                  <b>📦 No anúncio do Mercado Livre:</b>{' '}
                  {pacoteMl.data.peso_kg != null ? `${pacoteMl.data.peso_kg} kg` : 'peso não informado'}
                  {' · '}
                  {pacoteMl.data.altura_cm != null && pacoteMl.data.largura_cm != null && pacoteMl.data.comprimento_cm != null
                    ? `${pacoteMl.data.altura_cm} × ${pacoteMl.data.largura_cm} × ${pacoteMl.data.comprimento_cm} cm`
                    : 'medidas não informadas'}
                  <span className="ml-pack-src">
                    {pacoteMl.data.fonte === 'produto'
                      ? 'Medidas do produto (sem a embalagem) — confira antes de usar.'
                      : 'Embalagem declarada por quem vende esse produto.'}
                  </span>
                </div>
                <button type="button" className="ghost" onClick={() => aplicarPacote(pacoteMl.data, true)}>
                  Usar estes dados
                </button>
              </div>
            )}
            {(fontePacote.peso === 'anuncio' || fontePacote.medidas === 'anuncio') && (
              <div className="hint">
                ✓ {fontePacote.peso === 'anuncio' && fontePacote.medidas === 'anuncio'
                  ? 'Peso e medidas preenchidos'
                  : fontePacote.peso === 'anuncio' ? 'Peso preenchido' : 'Medidas preenchidas'}
                {' '}pelo anúncio do ML. Se a sua embalagem for outra, é só editar acima.
              </div>
            )}

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
                const c = nivelProcura(t)
                return (
                  <div className={'demand-card ' + c.tone}>
                    <div className="accent" />
                    <div className="body">
                      <div className="t">
                        {c.emo} {c.txt}
                        {/* com pouquíssimas visitas o % é ruído (1 → 4 = "+300%"),
                            então só mostramos quando há tráfego pra sustentar */}
                        {c.mostrarPct && t.change_pct != null
                          ? ` (${t.change_pct > 0 ? '+' : ''}${t.change_pct}%)`
                          : ''}
                      </div>
                      <div className="m">
                        Últimos {t.meia_janela} dias: <b>{t.recente}</b> visitas · {t.meia_janela} dias anteriores: <b>{t.antigo}</b>
                      </div>
                      <div className="d">
                        {c.nota ? c.nota + ' ' : ''}
                        Somado de {t.n_itens} anúncio{t.n_itens === 1 ? '' : 's'} do produto. Visita mede procura/interesse, não venda.
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

// ===========================================================================
// Publicar anúncio — assistente em 4 passos que cria o anúncio pela API do ML
// a partir de um produto do catálogo, seguindo as boas práticas de qualidade.
// ===========================================================================
function Publicar({ status }) {
  const [passo, setPasso] = useState(1)
  // passo 1 — busca
  const [q, setQ] = useState('')
  const [resultados, setResultados] = useState(null)
  const [buscando, setBuscando] = useState(false)
  const [carregando, setCarregando] = useState(false)
  // núcleo do anúncio (editável)
  const [anuncio, setAnuncio] = useState(null)
  const [urlFoto, setUrlFoto] = useState('')
  const [subindo, setSubindo] = useState(false)
  // passo 3
  const [fees, setFees] = useState(null)
  const [feesBusy, setFeesBusy] = useState(false)
  // validação / publicação
  const [validacao, setValidacao] = useState(null)
  const [validando, setValidando] = useState(false)
  const [publicando, setPublicando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [erro, setErro] = useState('')

  // Gate: publicar exige conta de vendedor conectada (o app token não publica).
  if (status && !status.seller_connected) {
    return (
      <>
        <div className="eyebrow">Publicação · API oficial do Mercado Livre</div>
        <h1>Publicar anúncio no Mercado Livre</h1>
        <p className="sub">
          Crie um anúncio já no padrão do Mercado Livre: dados vindos do catálogo, ficha técnica completa, fotos,
          garantia e descrição — com validação antes de publicar.
        </p>
        <div className="card connect-box">
          <div className="big-ic">🔑</div>
          <h2 style={{ justifyContent: 'center' }}>Conecte sua conta de vendedor</h2>
          <p className="sub" style={{ margin: '0 auto 16px' }}>
            Para publicar, o Mercado Livre precisa de uma conexão com permissão de escrita na sua conta.
          </p>
          <a className="primary" href="/api/auth/login" style={{ display: 'inline-block', width: 'auto', textDecoration: 'none' }}>
            Conectar minha conta
          </a>
        </div>
      </>
    )
  }

  function mapErroConexao(r) {
    if (r.error === 'vendedor_nao_conectado') return 'Conecte sua conta de vendedor para publicar.'
    const s = r.status || r.detail?.status
    if (s === 403 || /forbidden/i.test(r.error || '')) {
      return 'O token da conexão não tem permissão de escrita. Reconecte habilitando a publicação (write) no seu aplicativo do Mercado Livre.'
    }
    return r.detail?.message || r.error || 'Não consegui completar a operação agora.'
  }

  async function buscar() {
    const termo = q.trim()
    if (!termo) return
    setBuscando(true); setResultados(null); setErro('')
    try {
      const d = await fetch('/api/publicar/busca?q=' + encodeURIComponent(termo)).then((r) => r.json())
      setResultados(d.results || [])
    } catch {
      setErro('Não consegui buscar no catálogo agora. Tente de novo.')
    }
    setBuscando(false)
  }

  async function escolher(prod) {
    setCarregando(true); setErro('')
    try {
      const d = await fetch('/api/publicar/prefill?catalog_id=' + encodeURIComponent(prod.id)).then((r) => r.json())
      if (d.error) throw new Error(d.error)
      setAnuncio({
        catalog_id: d.catalog_id,
        catalog_listing: true,
        title: d.title || '',
        category_id: d.category_id || '',
        category_path: d.category_path || '',
        domain_id: d.domain_id || '',
        condition: d.suggested_condition || 'new',
        pictures: Array.isArray(d.pictures) ? d.pictures.slice(0, 10) : [],
        attributes: d.attributes || {},
        category_attributes: d.category_attributes || [],
        description: '',
        warranty_type: 'Garantia do vendedor',
        warranty_dias: '90',
        price: '',
        quantity: '1',
        listing_type_id: 'gold_special',
        logistic_type: 'cross_docking',
        free_shipping: true,
      })
      setFees(null); setValidacao(null); setResultado(null)
      setPasso(2)
    } catch {
      setErro('Não consegui carregar esse produto do catálogo. Tente outro.')
    }
    setCarregando(false)
  }

  const set = (k, v) => setAnuncio((a) => ({ ...a, [k]: v }))
  const setAttr = (id, v) => setAnuncio((a) => ({ ...a, attributes: { ...a.attributes, [id]: v } }))

  function addUrlFoto() {
    const u = urlFoto.trim()
    if (!u) return
    setAnuncio((a) => ({ ...a, pictures: [...a.pictures, { source: u, url: u }].slice(0, 10) }))
    setUrlFoto('')
  }
  function removerFoto(i) {
    setAnuncio((a) => ({ ...a, pictures: a.pictures.filter((_, k) => k !== i) }))
  }
  function moverFoto(i, dir) {
    setAnuncio((a) => {
      const p = [...a.pictures]
      const j = i + dir
      if (j < 0 || j >= p.length) return a
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp
      return { ...a, pictures: p }
    })
  }
  async function subirFotos(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setSubindo(true)
    const novos = []
    for (const file of files) {
      try {
        const r = await fetch('/api/publicar/foto', {
          method: 'POST',
          headers: { 'content-type': file.type || 'image/jpeg', 'x-filename': encodeURIComponent(file.name) },
          body: file,
        }).then((res) => res.json())
        if (r.id) novos.push({ id: r.id, url: r.url })
        else if (r.error) setErro(mapErroConexao(r))
      } catch { /* pula a foto que falhar */ }
    }
    setAnuncio((a) => ({ ...a, pictures: [...a.pictures, ...novos].slice(0, 10) }))
    setSubindo(false)
  }

  async function carregarFees() {
    if (!(Number(anuncio.price) > 0)) return
    setFeesBusy(true)
    try {
      const qs = new URLSearchParams({
        price: String(anuncio.price),
        category_id: anuncio.category_id || '',
        logistic_type: anuncio.logistic_type || 'cross_docking',
      })
      const d = await fetch('/api/publicar/fees?' + qs.toString()).then((r) => r.json())
      setFees(d)
    } catch { /* mostra sem tarifas */ }
    setFeesBusy(false)
  }

  function payload() {
    return {
      catalog_id: anuncio.catalog_id,
      catalog_listing: anuncio.catalog_listing,
      title: anuncio.title,
      category_id: anuncio.category_id,
      price: anuncio.price,
      quantity: anuncio.quantity,
      listing_type_id: anuncio.listing_type_id,
      condition: anuncio.condition,
      pictures: anuncio.pictures,
      attributes: anuncio.attributes,
      warranty: { type_name: anuncio.warranty_type, time: anuncio.warranty_dias },
      description: anuncio.description,
      free_shipping: anuncio.free_shipping,
      logistic_type: anuncio.logistic_type,
    }
  }

  async function validar() {
    setValidando(true); setValidacao(null); setErro('')
    try {
      const r = await fetch('/api/publicar/validar', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()),
      }).then((res) => res.json())
      if (r.error) setErro(mapErroConexao(r))
      else setValidacao(r)
    } catch {
      setErro('Não consegui validar agora. Tente de novo.')
    }
    setValidando(false)
  }

  async function publicar() {
    setPublicando(true); setErro('')
    try {
      const r = await fetch('/api/publicar/publicar', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()),
      }).then((res) => res.json())
      if (r.error) setErro(mapErroConexao(r))
      else { setResultado(r); setPasso(4) }
    } catch {
      setErro('Não consegui publicar agora. Tente de novo.')
    }
    setPublicando(false)
  }

  // ---- checklist de boas práticas (calculado a cada render) ----
  const reqAttrs = (anuncio?.category_attributes || []).filter((a) => a.required)
  const reqOk = reqAttrs.filter((a) => String(anuncio?.attributes?.[a.id] ?? '').trim())
  const temGtin = (anuncio?.category_attributes || []).some((a) => a.id === 'GTIN' || a.id === 'EAN')
  const gtinId = (anuncio?.category_attributes || []).find((a) => a.id === 'GTIN' || a.id === 'EAN')?.id
  const check = anuncio && {
    titulo: !!anuncio.title.trim() && anuncio.title.length <= TITULO_MAX && !TITULO_PROIBIDO.test(anuncio.title),
    fotos: anuncio.pictures.length >= 1,
    fotosIdeal: anuncio.pictures.length >= 6,
    ficha: reqAttrs.length === 0 || reqOk.length === reqAttrs.length,
    garantia: !!anuncio.warranty_type && (anuncio.warranty_type === 'Sem garantia' || Number(anuncio.warranty_dias) > 0),
    descricao: anuncio.description.trim().length >= 200,
    gtin: !temGtin || !!String(anuncio.attributes?.[gtinId] ?? '').trim(),
    preco: Number(anuncio.price) > 0,
    quantidade: Number(anuncio.quantity) > 0,
    categoria: !!anuncio.category_id,
  }
  const podePublicar = check && check.titulo && check.fotos && check.ficha && check.preco &&
    check.quantidade && check.categoria && validacao?.ok

  const tituloProibido = anuncio && TITULO_PROIBIDO.test(anuncio.title)

  return (
    <>
      <div className="eyebrow">Publicação · API oficial do Mercado Livre</div>
      <h1>Publicar anúncio no Mercado Livre</h1>
      <p className="sub">
        Monte o anúncio no padrão do Mercado Livre: dados do catálogo, ficha técnica completa, fotos, garantia e
        descrição. Você <b>valida</b> (sem publicar) e só publica quando estiver tudo certo.
      </p>

      <div className="pub-steps">
        {['1 · Produto', '2 · Revisão', '3 · Preço e tipo', '4 · Publicado'].map((t, i) => (
          <span key={i} className={'pub-step' + (passo === i + 1 ? ' on' : '') + (passo > i + 1 ? ' done' : '')}>{t}</span>
        ))}
      </div>

      {erro && <div className="callout bad"><b>Erro:</b> {erro}</div>}

      {/* ---------- PASSO 1: buscar produto no catálogo ---------- */}
      {passo === 1 && (
        <div className="card">
          <h2><span className="n">1</span> Ache o produto no catálogo do Mercado Livre</h2>
          <p className="hint" style={{ marginBottom: 10 }}>
            Buscar no catálogo garante que título, fotos e ficha técnica já venham no padrão do ML — a base de um anúncio
            de qualidade. Digite marca + modelo pra achar o produto certo.
          </p>
          <div className="row-inline">
            <div className="field" style={{ flex: 1 }}>
              <input
                placeholder="ex: fone jbl tune 510, echo dot 5a geração"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') buscar() }}
              />
            </div>
            <button className="primary" onClick={buscar} disabled={buscando}>
              {buscando ? 'Buscando…' : 'Buscar no catálogo'}
            </button>
          </div>

          {resultados && resultados.length === 0 && (
            <div className="hint" style={{ marginTop: 12 }}>
              Não achei esse produto no catálogo do Mercado Livre. Tente o nome específico (marca + modelo).
            </div>
          )}
          {resultados && resultados.length > 0 && (
            <div className="pub-catlist">
              {resultados.map((p) => (
                <button key={p.id} className="pub-catopt" onClick={() => escolher(p)} disabled={carregando}>
                  {p.thumbnail
                    ? <img src={p.thumbnail} alt="" className="mkt-thumb" />
                    : <div className="mkt-thumb" style={{ display: 'grid', placeItems: 'center', color: 'var(--soft)' }}>—</div>}
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <div className="mkt-name" style={{ fontSize: 14 }}>{p.name}</div>
                    <div className="hint"><code>{p.id}</code>{p.domain_id ? ` · ${p.domain_id}` : ''}</div>
                  </div>
                  <span className="ghost" style={{ pointerEvents: 'none' }}>{carregando ? '…' : 'Usar este ▸'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------- PASSOS 2 e 3: revisão + preço, com checklist lateral ---------- */}
      {anuncio && (passo === 2 || passo === 3) && (
        <div className="grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {passo === 2 && (
              <>
                <div className="card">
                  <h2><span className="n">2</span> Título e categoria</h2>
                  {anuncio.catalog_listing && (
                    <div className="callout" style={{ margin: '0 0 12px' }}>
                      ✅ <b>Vinculado ao catálogo</b> — o Mercado Livre usa o título e as fotos padronizados do produto.
                      As edições abaixo valem quando você desligar o catálogo (anúncio fora do catálogo).
                    </div>
                  )}
                  <div className="field">
                    <label>Título ({anuncio.title.length}/{TITULO_MAX})</label>
                    <input value={anuncio.title} maxLength={80} onChange={(e) => set('title', e.target.value)} />
                    <div className="hint">Boa prática: <b>Produto + Marca + Modelo + specs</b>. Sem "frete grátis", "oferta", "promoção" ou links.</div>
                    {tituloProibido && <div className="callout bad" style={{ marginTop: 8 }}>O título tem uma palavra que o Mercado Livre não permite. Remova-a antes de publicar.</div>}
                  </div>
                  <div className="field">
                    <label>Categoria</label>
                    <input value={anuncio.category_id} onChange={(e) => set('category_id', e.target.value)} />
                    {anuncio.category_path && <div className="hint">{anuncio.category_path}</div>}
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={anuncio.catalog_listing} onChange={(e) => set('catalog_listing', e.target.checked)} />
                    Anunciar no catálogo do Mercado Livre (recomendado)
                  </label>
                </div>

                <div className="card">
                  <h2><span className="n">📷</span> Fotos ({anuncio.pictures.length}/10)</h2>
                  <p className="hint" style={{ marginBottom: 10 }}>
                    A 1ª foto é a capa — use fundo branco. O ideal são pelo menos 6 fotos, com boa resolução (≥1200px).
                  </p>
                  {anuncio.pictures.length > 0 && (
                    <div className="fotos-grid">
                      {anuncio.pictures.map((p, i) => (
                        <div className="foto" key={i}>
                          <img src={p.url || p.source} alt="" />
                          {i === 0 && <span className="foto-capa">capa</span>}
                          <div className="foto-acts">
                            <button className="ghost" onClick={() => moverFoto(i, -1)} disabled={i === 0} title="mover pra esquerda">◀</button>
                            <button className="ghost" onClick={() => moverFoto(i, 1)} disabled={i === anuncio.pictures.length - 1} title="mover pra direita">▶</button>
                            <button className="ghost" onClick={() => removerFoto(i)} title="remover">✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="row-inline" style={{ marginTop: 12 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <input placeholder="colar URL de uma imagem" value={urlFoto}
                        onChange={(e) => setUrlFoto(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addUrlFoto() }} />
                    </div>
                    <button className="ghost" onClick={addUrlFoto}>Adicionar URL</button>
                  </div>
                  <label className="pub-upload">
                    <input type="file" accept="image/*" multiple style={{ display: 'none' }}
                      onChange={(e) => { subirFotos(e.target.files); e.target.value = '' }} />
                    {subindo ? 'Enviando…' : '📤 Enviar fotos do computador'}
                  </label>
                </div>

                <div className="card">
                  <h2><span className="n">📋</span> Ficha técnica {reqAttrs.length > 0 && <span className="pill">{reqOk.length}/{reqAttrs.length} obrigatórios</span>}</h2>
                  <p className="hint" style={{ marginBottom: 10 }}>
                    Quanto mais completa a ficha, melhor o anúncio aparece nas buscas. Os campos marcados são obrigatórios.
                  </p>
                  {(anuncio.category_attributes || []).length === 0 && (
                    <div className="hint">Sem atributos de ficha técnica para esta categoria.</div>
                  )}
                  {(anuncio.category_attributes || []).map((a) => {
                    const val = anuncio.attributes[a.id] ?? ''
                    const usarSelect = a.values.length > 0 && !a.allow_custom_value
                    return (
                      <div className="field" key={a.id}>
                        <label>{a.name}{a.required && <span style={{ color: 'var(--bad)' }}> *</span>}</label>
                        {usarSelect ? (
                          <select value={val} onChange={(e) => setAttr(a.id, e.target.value)}>
                            <option value="">— escolher —</option>
                            {a.values.map((v) => <option key={v.id || v.name} value={v.name}>{v.name}</option>)}
                          </select>
                        ) : (
                          <input value={val} list={a.values.length ? `dl-${a.id}` : undefined}
                            placeholder={a.hint || ''} onChange={(e) => setAttr(a.id, e.target.value)} />
                        )}
                        {!usarSelect && a.values.length > 0 && (
                          <datalist id={`dl-${a.id}`}>{a.values.map((v) => <option key={v.id || v.name} value={v.name} />)}</datalist>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="card">
                  <h2><span className="n">🛡️</span> Condição, garantia e descrição</h2>
                  <div className="row2">
                    <div className="field">
                      <label>Condição</label>
                      <select value={anuncio.condition} onChange={(e) => set('condition', e.target.value)}>
                        {CONDICOES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label>Tipo de garantia</label>
                      <select value={anuncio.warranty_type} onChange={(e) => set('warranty_type', e.target.value)}>
                        {WARRANTY_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </div>
                  </div>
                  {anuncio.warranty_type !== 'Sem garantia' && (
                    <div className="field">
                      <label>Garantia (dias)</label>
                      <input type="number" value={anuncio.warranty_dias} onChange={(e) => set('warranty_dias', e.target.value)} />
                    </div>
                  )}
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Descrição (texto puro — o ML não aceita HTML)</label>
                    <textarea rows={6} value={anuncio.description} onChange={(e) => set('description', e.target.value)}
                      placeholder="Descreva o produto: características, o que acompanha, diferenciais…"
                      style={{ width: '100%', fontFamily: 'inherit', fontSize: 14.5, padding: '10px 11px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', resize: 'vertical' }} />
                    <div className="hint">{anuncio.description.trim().length} caracteres · recomendado ≥ 200.</div>
                  </div>
                </div>

                <button className="primary" onClick={() => { setPasso(3); carregarFees() }}>
                  Continuar para preço e tipo ▸
                </button>
              </>
            )}

            {passo === 3 && (
              <>
                <div className="card">
                  <h2><span className="n">3</span> Preço, quantidade e envio</h2>
                  <div className="row2">
                    <div className="field">
                      <label>Preço (R$)</label>
                      <input type="number" step="0.01" value={anuncio.price}
                        onChange={(e) => set('price', e.target.value)} onBlur={carregarFees} />
                    </div>
                    <div className="field">
                      <label>Quantidade em estoque</label>
                      <input type="number" value={anuncio.quantity} onChange={(e) => set('quantity', e.target.value)} />
                    </div>
                  </div>
                  <div className="field">
                    <label>Como você despacha</label>
                    <select value={anuncio.logistic_type} onChange={(e) => { set('logistic_type', e.target.value); }}>
                      {LOGISTIC_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={anuncio.free_shipping} onChange={(e) => set('free_shipping', e.target.checked)} />
                    Oferecer frete grátis
                  </label>
                </div>

                <div className="card">
                  <h2><span className="n">🏷️</span> Tipo de anúncio</h2>
                  <p className="hint" style={{ marginBottom: 10 }}>
                    O <b>Clássico</b> tem comissão menor; o <b>Premium</b> custa mais mas dá parcelamento sem juros e mais exposição.
                    {' '}<button className="ghost" onClick={carregarFees} disabled={feesBusy || !(Number(anuncio.price) > 0)} style={{ marginLeft: 6 }}>
                      {feesBusy ? 'Calculando…' : 'Comparar tarifas'}
                    </button>
                  </p>
                  <div className="pub-tipos">
                    {LISTING_TYPES.map((t) => {
                      const f = fees?.[t.id]
                      const sel = anuncio.listing_type_id === t.id
                      const preco = Number(anuncio.price) || 0
                      const comissao = f?.commission_total
                      const frete = f?.freight
                      const sobra = (comissao != null && preco > 0) ? preco - comissao - (frete || 0) - imposto(preco) : null
                      return (
                        <button key={t.id} className={'pub-tipo' + (sel ? ' on' : '')} onClick={() => set('listing_type_id', t.id)}>
                          <div className="pub-tipo-h">{sel ? '✓ ' : ''}{t.label}</div>
                          {f?.error ? (
                            <div className="hint">tarifa indisponível</div>
                          ) : f ? (
                            <div className="pub-tipo-b">
                              <div className="brow"><span className="k">Comissão</span><span className="v">{comissao != null ? money(comissao) : '—'}</span></div>
                              {f.fixed_fee > 0 && <div className="brow sub"><span className="k">↳ custo fixo</span><span className="v">{money(f.fixed_fee)}</span></div>}
                              <div className="brow"><span className="k">Frete{f.freight_is_estimate ? ' (est.)' : ''}</span><span className="v">{frete != null ? money(frete) : '—'}</span></div>
                              <div className="brow total"><span className="k">Sobra estimada</span><span className={'v ' + (sobra >= 0 ? 'pos' : 'neg')}>{sobra != null ? money(sobra) : '—'}</span></div>
                            </div>
                          ) : (
                            <div className="hint">clique em "Comparar tarifas"</div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    A sobra estimada já desconta a comissão, o frete e o imposto federal ({IMPOSTO_PCT}%). Não inclui ICMS nem o seu custo.
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="ghost" onClick={() => setPasso(2)} style={{ flex: '0 0 auto' }}>◀ Voltar</button>
                  <button className="primary" onClick={validar} disabled={validando}>
                    {validando ? 'Validando no Mercado Livre…' : '✔ Validar no Mercado Livre (não publica)'}
                  </button>
                </div>

                {validacao && (validacao.ok ? (
                  <div className="callout"><b>✓ O Mercado Livre aceitou o anúncio</b> — simulação, nada foi publicado. Você já pode publicar de verdade.</div>
                ) : (
                  <div className="callout bad">
                    <b>O Mercado Livre apontou {validacao.erros.length} ponto(s):</b>
                    <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                      {validacao.erros.map((e, i) => <li key={i} style={{ fontSize: 12.5, marginBottom: 3 }}>{e.message_pt}</li>)}
                    </ul>
                  </div>
                ))}

                <button className="primary" onClick={publicar} disabled={!podePublicar || publicando}
                  style={{ background: podePublicar ? undefined : 'var(--soft)' }}>
                  {publicando ? 'Publicando…' : '🚀 Publicar anúncio'}
                </button>
                {!podePublicar && !publicando && (
                  <div className="hint" style={{ textAlign: 'center' }}>
                    Para liberar a publicação: complete o checklist e passe na validação.
                  </div>
                )}
              </>
            )}
          </div>

          {/* checklist lateral */}
          <div className="result-card">
            <div className="card">
              <h2><span className="n">✓</span> Boas práticas</h2>
              <div className="pub-check">
                <Item ok={check.categoria} txt="Categoria definida" />
                <Item ok={check.titulo} txt={`Título ok (≤${TITULO_MAX}, sem termos proibidos)`} />
                <Item ok={check.fotos} txt="Pelo menos 1 foto" />
                <Item ok={check.fotosIdeal} txt="6+ fotos (ideal)" soft />
                <Item ok={check.ficha} txt={reqAttrs.length ? `Ficha: obrigatórios (${reqOk.length}/${reqAttrs.length})` : 'Ficha técnica'} />
                {temGtin && <Item ok={check.gtin} txt="Código de barras (GTIN/EAN)" />}
                <Item ok={check.garantia} txt="Garantia definida" />
                <Item ok={check.descricao} txt="Descrição ≥ 200 caracteres" soft />
                <Item ok={check.preco} txt="Preço definido" />
                <Item ok={check.quantidade} txt="Quantidade definida" />
                <Item ok={!!validacao?.ok} txt="Validado pelo Mercado Livre" />
              </div>
              <div className="hint" style={{ marginTop: 10 }}>
                Itens em cinza são recomendações — não bloqueiam a publicação.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------- PASSO 4: resultado ---------- */}
      {passo === 4 && resultado && (
        <div className="card">
          <div className="verdict good">
            <div className="lbl">Anúncio publicado</div>
            <div className="big">🎉 {resultado.item_id}</div>
            {resultado.health != null && <div className="pct">Qualidade da publicação: {Math.round(resultado.health * 100)}%</div>}
          </div>
          <div>
            <div className="brow"><span className="k">Status</span><span className="v">{resultado.status || '—'}</span></div>
            <div className="brow"><span className="k">Descrição enviada</span><span className="v">{resultado.description_ok === false ? 'falhou (edite depois)' : resultado.description_ok ? 'sim' : '—'}</span></div>
          </div>
          {resultado.warnings?.length > 0 && (
            <div className="callout warn" style={{ marginTop: 12 }}>
              <b>Avisos do Mercado Livre:</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {resultado.warnings.map((w, i) => <li key={i} style={{ fontSize: 12.5 }}>{typeof w === 'string' ? w : (w.message || w.code)}</li>)}
              </ul>
            </div>
          )}
          {resultado.permalink && (
            <a className="primary" href={resultado.permalink} target="_blank" rel="noreferrer"
              style={{ display: 'block', textAlign: 'center', marginTop: 14, textDecoration: 'none' }}>
              Abrir o anúncio no Mercado Livre ▸
            </a>
          )}
          <button className="ghost" style={{ width: '100%', marginTop: 10 }}
            onClick={() => { setAnuncio(null); setResultado(null); setValidacao(null); setResultados(null); setQ(''); setPasso(1) }}>
            Publicar outro
          </button>
        </div>
      )}

      <footer>
        A publicação usa a API oficial do Mercado Livre com a sua conta de vendedor conectada. "Validar" apenas simula
        (não cria nada); só "Publicar" cria o anúncio de verdade na sua conta.
      </footer>
    </>
  )
}

function Item({ ok, txt, soft }) {
  return (
    <div className={'pub-check-row' + (ok ? ' ok' : soft ? ' soft' : ' no')}>
      <span className="pub-check-ic">{ok ? '✓' : soft ? '○' : '✗'}</span>{txt}
    </div>
  )
}

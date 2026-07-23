// Frete do Mercado Envios — tabela base + REGRAS POR MODALIDADE DE ENVIO.
//
// Este arquivo é puro (sem dependência de Node) de propósito: o servidor usa
// pra calcular /api/fees e o front (App.jsx) importa o mesmo código pra mostrar
// limites, peso cobrável e o comparativo entre modalidades na tela.
//
// A tabela é um retrato aproximado (o ML não publica na API). O número REAL sai
// de /users/{uid}/shipping_options/free quando o vendedor está conectado —
// veja getRealFreight() em ml.js. Aqui é o fallback / a simulação.

const PRICE_BRACKETS = [18.99, 48.99, 78.99, 99.99, 119.99, 149.99, 199.99, Infinity]
const FREIGHT_TABLE = [
  [0.3, 5.65, 6.55, 7.75, 12.35, 14.35, 16.45, 18.45, 20.95],
  [0.5, 5.95, 6.65, 7.85, 13.25, 15.45, 17.65, 19.85, 22.55],
  [1, 6.05, 6.75, 7.95, 13.85, 16.15, 18.45, 20.75, 23.65],
  [1.5, 6.15, 6.85, 8.05, 14.15, 16.45, 18.85, 21.15, 24.65],
  [2, 6.25, 6.95, 8.15, 14.45, 16.85, 19.25, 21.65, 24.65],
  [3, 6.35, 7.95, 8.55, 15.75, 18.35, 21.05, 23.65, 26.25],
  [4, 6.45, 8.15, 8.95, 17.05, 19.85, 22.65, 25.55, 28.35],
  [5, 6.55, 8.35, 9.75, 18.45, 21.55, 24.65, 27.75, 30.75],
  [6, 6.65, 8.55, 9.95, 25.45, 28.55, 32.65, 35.75, 39.75],
  [7, 6.75, 8.75, 10.15, 27.05, 31.05, 36.05, 40.05, 44.05],
  [8, 6.85, 8.95, 10.35, 28.85, 33.65, 38.45, 43.25, 48.05],
  [9, 6.95, 9.15, 10.55, 29.65, 34.55, 39.55, 44.45, 49.35],
  [11, 7.05, 9.55, 10.95, 41.25, 48.05, 54.95, 61.75, 68.65],
  [13, 7.15, 9.95, 11.35, 42.15, 49.25, 56.25, 63.25, 70.25],
  [15, 7.25, 10.15, 11.55, 45.05, 52.45, 59.95, 67.45, 74.95],
  [17, 7.35, 10.35, 11.75, 48.55, 56.05, 63.55, 70.75, 78.65],
  [20, 7.45, 10.55, 11.95, 54.75, 63.85, 72.95, 82.05, 91.15],
  [25, 7.65, 10.95, 12.15, 64.05, 75.05, 84.75, 95.35, 105.95],
  [30, 7.75, 11.15, 12.35, 65.95, 75.45, 85.55, 96.25, 106.95],
  [Infinity, 8.75, 12.95, 14.35, 166.15, 192.45, 217.55, 242.55, 261.95],
]

const priceCol = (p) => { for (let i = 0; i < PRICE_BRACKETS.length; i++) if (p <= PRICE_BRACKETS[i]) return i; return PRICE_BRACKETS.length - 1 }
const weightRow = (w) => { for (let i = 0; i < FREIGHT_TABLE.length; i++) if (w <= FREIGHT_TABLE[i][0]) return i; return FREIGHT_TABLE.length - 1 }
const round2 = (n) => Math.round(n * 100) / 100
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Tarifa cheia do Mercado Envios pro peso cobrável e a faixa de preço.
export const tarifaBase = (pesoCobravelKg, preco) => FREIGHT_TABLE[weightRow(pesoCobravelKg)][priceCol(preco) + 1]

// ---------------------------------------------------------------------------
// Faixas de preço (regra do subsídio)
// ---------------------------------------------------------------------------
// < R$19        : sem subsídio — normalmente o comprador paga; se você oferecer
//                 frete grátis por conta própria, o custo é seu.
// R$19–R$78,99  : o ML cobre o frete (produto NOVO e elegível).
// >= R$79       : frete grátis; o vendedor paga com o desconto da reputação.
export const SUBSIDIO_MIN = 19
export const SUBSIDIO_MAX = 79 // exclusivo — a faixa vai até R$78,99

export function faixaPreco(preco) {
  const p = num(preco)
  if (p < SUBSIDIO_MIN) return 'abaixo_19'
  if (p < SUBSIDIO_MAX) return 'subsidiada'
  return 'acima_79'
}

// ---------------------------------------------------------------------------
// Modalidades de envio — limites físicos e modelo de custo
// ---------------------------------------------------------------------------
// IMPORTANTE: participar do Decola coloca a conta como reputação VERDE-CLARO,
// mas NÃO libera automaticamente todas as modalidades. O que está disponível
// depende de endereço, cobertura, categoria, dimensões e da configuração
// logística efetivamente liberada pelo ML. Por isso nada aqui é marcado
// sozinho — a modalidade é sempre uma escolha do usuário.
// A ORDEM das chaves aqui é a ordem do select na tela — Correios primeiro,
// porque é a modalidade padrão da loja.
export const MODALIDADES = {
  drop_off: {
    id: 'drop_off',
    label: 'Correios',
    modelo: 'tradicional',
    limites: { pesoKg: 30, somaCm: 200, maiorLadoCm: 100 },
    despacho: 'O ML gera a etiqueta e diz onde postar. Nos Correios você não paga PAC/Sedex no balcão — o frete é administrado pelo Mercado Envios.',
    notas: ['Envio particular feito por fora não é reembolsado pelo Mercado Livre.'],
  },
  cross_docking: {
    id: 'cross_docking',
    label: 'Coleta',
    modelo: 'tradicional',
    limites: { pesoKg: 50, somaCm: 300, maiorLadoCm: 200 },
    despacho: 'O ML retira os pacotes no endereço cadastrado. A retirada é grátis; a entrega ao comprador segue a tabela do Mercado Envios.',
  },
  xd_drop_off: {
    id: 'xd_drop_off',
    label: 'Credenciado',
    modelo: 'tradicional',
    limites: { pesoKg: 50, somaCm: 300, maiorLadoCm: 200 },
    despacho: 'Você leva o pacote até um ponto credenciado do Mercado Livre (comércio parceiro, não é Correios). A etiqueta diz onde e até que horas entregar.',
    notas: ['Operando por ponto credenciado, pode ser exigida a emissão e anexação da nota fiscal.', 'Etiqueta de credenciado não pode ser levada aos Correios.'],
  },
  fulfillment: {
    id: 'fulfillment',
    label: 'Full',
    modelo: 'full',
    limites: { pesoKg: 25, somaCm: 260, maiorLadoCm: 120 },
    despacho: 'Seu estoque fica no centro de distribuição do ML, que separa, embala e entrega. Não é liberado só por estar no Decola — a conta precisa cumprir os requisitos e ativar o serviço.',
    notas: ['Acima de R$79 o ML cobre 50% do frete grátis (o resto é seu).', 'Full não é custo zero: tem armazenagem, operação e cobrança de estoque antigo.'],
  },
  self_service: {
    id: 'self_service',
    label: 'Flex',
    modelo: 'flex',
    // No Flex os limites são os que VOCÊ cadastra pra sua operação — estes são os tetos.
    limites: { pesoKg: 80, somaCm: null, maiorLadoCm: 300 },
    despacho: 'A entrega é sua (veículo próprio, motoboy ou transportadora) e o app do ML controla rastreio e confirmação. Depende da sua área estar atendida.',
    notas: ['O ML paga a TARIFA da plataforma, não o que o seu entregador cobra — a diferença é custo (ou lucro) seu.'],
  },
}

export const MODALIDADE_IDS = Object.keys(MODALIDADES)
export const getModalidade = (logisticType) => MODALIDADES[logisticType] || MODALIDADES.drop_off

// ---------------------------------------------------------------------------
// Peso e medidas
// ---------------------------------------------------------------------------
export const pesoVolumetricoKg = (alturaCm, larguraCm, comprimentoCm) => {
  const a = num(alturaCm), l = num(larguraCm), c = num(comprimentoCm)
  if (a <= 0 || l <= 0 || c <= 0) return 0
  return (a * l * c) / 6000
}

// Peso cobrável = o MAIOR entre o peso real e o volumétrico.
export function pesoCobravelKg(pesoRealKg, dims = {}) {
  const vol = pesoVolumetricoKg(dims.alturaCm, dims.larguraCm, dims.comprimentoCm)
  return Math.max(num(pesoRealKg), vol)
}

// Confere o pacote contra os limites da modalidade. Os limites valem sobre as
// medidas FÍSICAS e o peso REAL (não sobre o peso cobrável).
export function checarLimites(logisticType, pesoRealKg, dims = {}) {
  const m = getModalidade(logisticType)
  const lim = m.limites
  const a = num(dims.alturaCm), l = num(dims.larguraCm), c = num(dims.comprimentoCm)
  const temMedidas = a > 0 && l > 0 && c > 0
  const soma = temMedidas ? round2(a + l + c) : null
  const maiorLado = temMedidas ? Math.max(a, l, c) : null
  const peso = num(pesoRealKg)

  const excedeu = {
    peso: lim.pesoKg != null && peso > lim.pesoKg,
    soma: lim.somaCm != null && soma != null && soma > lim.somaCm,
    lado: lim.maiorLadoCm != null && maiorLado != null && maiorLado > lim.maiorLadoCm,
  }
  const mensagens = []
  if (excedeu.peso) mensagens.push(`Peso ${peso} kg passa do limite de ${lim.pesoKg} kg da modalidade ${m.label}.`)
  if (excedeu.soma) mensagens.push(`Soma dos lados ${soma} cm passa do limite de ${lim.somaCm} cm da modalidade ${m.label}.`)
  if (excedeu.lado) mensagens.push(`Maior lado ${maiorLado} cm passa do limite de ${lim.maiorLadoCm} cm da modalidade ${m.label}.`)
  if (m.modelo === 'flex' && (excedeu.peso || excedeu.lado)) {
    mensagens.push('No Flex esses tetos ainda dependem da capacidade que você cadastrou pra sua operação.')
  }
  if (m.id === 'drop_off' && (excedeu.peso || excedeu.soma || excedeu.lado)) {
    mensagens.push('Acima dos limites dos Correios o pacote pode ser recusado na postagem.')
  }

  return {
    modalidade: m.id,
    modalidade_label: m.label,
    limites: lim,
    tem_medidas: temMedidas,
    peso_real_kg: peso,
    soma_cm: soma,
    maior_lado_cm: maiorLado,
    excedeu,
    ok: !excedeu.peso && !excedeu.soma && !excedeu.lado,
    mensagens,
  }
}

// ---------------------------------------------------------------------------
// Cálculo do frete por modalidade
// ---------------------------------------------------------------------------
// opts:
//   alturaCm, larguraCm, comprimentoCm  — medidas da caixa
//   descontoReputacao (0..0.7)          — Decola = verde-claro; o % real vem da cotação da conta
//   elegivelSubsidio (default true)     — produto NOVO e elegível (condição pro ML cobrir R$19–78,99)
//   custoOperacaoFull (R$/unidade)      — armazenagem/operação do Full
//   custoEntregaFlex (R$)               — o que o SEU motoboy/transportadora cobra
//
// Retorna o detalhamento completo. custo_total é o que sai do bolso do vendedor.
export function estimarFreteDetalhado(preco, pesoRealKg, logisticType, ofereceFreteGratis, opts = {}) {
  const {
    alturaCm, larguraCm, comprimentoCm,
    descontoReputacao = 0,
    elegivelSubsidio = true,
    custoOperacaoFull = 0,
    custoEntregaFlex = null,
  } = opts

  const m = getModalidade(logisticType)
  const p = num(preco)
  const dims = { alturaCm, larguraCm, comprimentoCm }
  const pesoCob = round2(pesoCobravelKg(pesoRealKg, dims))
  const volKg = round2(pesoVolumetricoKg(alturaCm, larguraCm, comprimentoCm))
  const limites = checarLimites(logisticType, pesoRealKg, dims)
  const faixa = faixaPreco(p)
  const desc = Math.min(Math.max(num(descontoReputacao), 0), 0.7)
  const tarifa = round2(tarifaBase(pesoCob, p))
  const tarifaComDesconto = round2(tarifa * (1 - desc))

  const avisos = []
  if (volKg > num(pesoRealKg)) avisos.push(`O peso volumétrico (${volKg} kg) é maior que o real (${num(pesoRealKg)} kg) — a cobrança usa o volumétrico.`)
  if (!limites.tem_medidas) avisos.push('Sem as medidas da caixa eu não consigo checar os limites nem o peso volumétrico.')
  if (!limites.ok) avisos.push(...limites.mensagens)
  if (desc > 0) avisos.push(`Desconto de reputação de ${Math.round(desc * 100)}% aplicado (Decola = verde-claro). O percentual real vem da cotação da conta.`)

  // O que o vendedor paga de FRETE, por modelo de custo.
  let custoFrete = null
  let regra = ''
  let coberturaMlPct = 0
  let recebeDoMl = 0      // só Flex: incentivo pago pelo ML
  let custoExtra = 0      // Full: armazenagem/operação · Flex: entrega própria

  if (m.modelo === 'flex') {
    // No Flex o ML paga uma TARIFA e a entrega é feita (e paga) por você.
    // Sem o custo real informado, assumo que o entregador cobra o mesmo que a
    // tarifa da plataforma — é a hipótese neutra.
    const custoEntrega = custoEntregaFlex == null ? tarifa : num(custoEntregaFlex)
    if (custoEntregaFlex == null) avisos.push('Custo real da entrega não informado — assumi o mesmo valor da tarifa do ML. Informe quanto o motoboy/transportadora cobra pra ficar exato.')

    if (faixa === 'subsidiada' && elegivelSubsidio) {
      coberturaMlPct = 1
      regra = 'Faixa R$19–78,99: o ML cobre 100% da tarifa de envio do Flex.'
    } else if (faixa === 'acima_79') {
      coberturaMlPct = 0.10
      regra = 'A partir de R$79: reputação verde recebe cobertura de 10% da tarifa de envio.'
    } else {
      coberturaMlPct = 0
      regra = faixa === 'abaixo_19'
        ? 'Abaixo de R$19 não há cobertura — a entrega sai do seu bolso.'
        : 'Produto não elegível ao subsídio — sem cobertura do ML.'
    }
    recebeDoMl = round2(tarifa * coberturaMlPct)
    custoFrete = round2(custoEntrega - recebeDoMl)
    avisos.push('O ML cobre a TARIFA da plataforma, não o que o seu entregador cobra — a diferença é custo (ou lucro) logístico seu.')
  } else if (m.modelo === 'full') {
    custoExtra = round2(num(custoOperacaoFull))
    if (faixa === 'abaixo_19') {
      custoFrete = ofereceFreteGratis ? tarifaComDesconto : 0
      regra = ofereceFreteGratis
        ? 'Abaixo de R$19 não há subsídio — o frete grátis voluntário é pago por você.'
        : 'Abaixo de R$19 sem frete grátis: quem paga o envio é o comprador.'
    } else if (faixa === 'subsidiada') {
      if (elegivelSubsidio) {
        coberturaMlPct = 1
        custoFrete = 0
        regra = 'Faixa R$19–78,99: frete grátis aplicado nos produtos elegíveis do Full.'
      } else {
        custoFrete = tarifaComDesconto
        regra = 'Produto não elegível ao frete grátis — o custo fica com você.'
      }
    } else {
      coberturaMlPct = 0.5
      custoFrete = round2(tarifaComDesconto * 0.5)
      regra = 'A partir de R$79 o Mercado Livre cobre 50% do frete grátis no Full — o resto é seu.'
    }
    avisos.push('Full não é custo zero: armazenagem, operação e estoque antigo entram na sua margem e não estão na tabela de frete.')
  } else {
    // Tradicional — Correios, Coleta e Credenciado usam a mesma regra
    // financeira; o que muda é o local de despacho e os limites.
    if (faixa === 'abaixo_19') {
      custoFrete = ofereceFreteGratis ? tarifaComDesconto : 0
      regra = ofereceFreteGratis
        ? 'Abaixo de R$19 não há subsídio — o frete grátis voluntário é pago por você.'
        : 'Abaixo de R$19 sem frete grátis: quem paga o envio é o comprador.'
    } else if (faixa === 'subsidiada') {
      if (elegivelSubsidio) {
        coberturaMlPct = 1
        custoFrete = 0
        regra = 'Faixa R$19–78,99: o Mercado Livre cobre o frete em produtos novos e elegíveis.'
      } else {
        custoFrete = tarifaComDesconto
        regra = 'Produto não elegível ao subsídio — o custo do envio fica com você.'
      }
    } else {
      custoFrete = tarifaComDesconto
      regra = 'A partir de R$79 o frete sai do seu bolso, já com o desconto da sua reputação.'
    }
  }

  return {
    modalidade: m.id,
    modalidade_label: m.label,
    modelo: m.modelo,
    despacho: m.despacho,
    notas: m.notas || [],
    faixa,
    preco: p,
    peso_real_kg: num(pesoRealKg),
    peso_volumetrico_kg: volKg,
    peso_cobravel_kg: pesoCob,
    tarifa_base: tarifa,
    desconto_reputacao: desc,
    tarifa_com_desconto: tarifaComDesconto,
    cobertura_ml_pct: coberturaMlPct,
    recebe_do_ml: recebeDoMl,
    custo_frete: custoFrete,
    custo_extra: custoExtra,
    custo_total: round2(num(custoFrete) + custoExtra),
    regra,
    limites,
    avisos,
  }
}

// Compat: continua devolvendo só o número que sai do bolso do vendedor.
export function estimarFrete(preco, pesoRealKg, logisticType, ofereceFreteGratis, opts = {}) {
  return estimarFreteDetalhado(preco, pesoRealKg, logisticType, ofereceFreteGratis, opts).custo_total
}

// Simula TODAS as modalidades com o mesmo pacote — usado no comparativo da tela.
// Não marca nenhuma como disponível: o que a conta pode usar depende de
// cobertura, endereço, categoria e liberação do ML.
export function compararModalidades(preco, pesoRealKg, ofereceFreteGratis, opts = {}) {
  return MODALIDADE_IDS.map((id) => estimarFreteDetalhado(preco, pesoRealKg, id, ofereceFreteGratis, opts))
}

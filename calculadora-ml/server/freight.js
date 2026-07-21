// Estimativa de frete (o frete REAL exige login do vendedor via /shipping_options).
// Tabela é um retrato aproximado, não publicado na API oficial — confirme no painel.

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

// logistic_type do ML -> nosso agrupamento
const FLEX = new Set(['self_service'])

export function estimarFrete(preco, pesoKg, logisticType, ofereceFreteGratis) {
  if (FLEX.has(logisticType)) {
    if (preco < 19) return 6.25
    if (preco <= 48.99) return 6.65
    if (preco <= 78.99) return 7.75
    return null // acima de R$79 no Flex o custo real não é público
  }
  // Coleta / Agência / Full
  const abaixoLimite = preco < 79
  if (abaixoLimite && !ofereceFreteGratis) return 0 // comprador paga
  return FREIGHT_TABLE[weightRow(pesoKg)][priceCol(preco) + 1]
}

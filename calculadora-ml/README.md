# Calculadora de Lucro — Mercado Livre (taxas reais)

App local (Vite + React) + scripts que usam as **taxas reais da API oficial** do Mercado Livre:
comissão e custo fixo (regra de mar/2026) direto da sua conta.

Autenticação por **client_credentials**: basta o Client ID + Secret do seu app.
**Não precisa de login de usuário, redirect URI nem PKCE.** O secret fica só na sua máquina.

---

## Setup (uma vez)

1. No [DevCenter](https://developers.mercadolivre.com.br/devcenter), pegue o **Client ID** e a **Secret Key** do seu app.
   (Deixe o fluxo **Client Credentials** ativado. Não precisa configurar redirect URI.)
2. Copie `.env.example` para `.env` e preencha `ML_CLIENT_ID` e `ML_CLIENT_SECRET`.
3. `npm install`

## 1) Calculadora na tela (1 produto por vez)

```bash
npm run dev
```
Abre em http://localhost:5173. Você digita preço, custo, categoria e envio, e vê a comissão
real + custo fixo real na hora. (O frete é estimado — veja abaixo.)

## 2) Simulador de preço mínimo — o catálogo inteiro (RECOMENDADO)

Para cada produto do seu CSV (que só tem o custo), calcula com a **comissão real da categoria**:
o preço mínimo pra empatar e pra ter a margem-alvo.

```bash
node scripts/precos.js ../estoq.csv --margem 20            # margem líquida de 20%
node scripts/precos.js ../estoq.csv --margem 30 --limit 50 # teste com 50, margem 30%
node scripts/precos.js ../estoq.csv --sem-categoria        # mais rápido (comissão padrão)
```
Gera `precos_minimos.csv` (abre no Excel). Cobre **100%** dos produtos. Retomável (`resume`) se parar.

## 3) Comparação com concorrente (LIMITADO)

```bash
node scripts/batch.js ../estoq.csv --limit 50
```
Tenta achar o preço do concorrente no **catálogo** do ML. ⚠️ **Cobertura baixíssima**: o ML
descontinuou a busca geral por palavra-chave (`/sites/MLB/search?q=` dá 403), então só acha preço
de produtos que estão no catálogo com vendedor ativo — quase nenhum item de papelaria se encaixa.
Mantido para os casos (marcas populares) em que existe competição de catálogo.

---

## Limitações honestas

- **Preço de concorrente:** a API pública de busca por palavra-chave foi descontinuada pelo ML
  (sem substituto). Não dá pra reproduzir em massa a comparação de preços de concorrentes, nem com
  login de vendedor. Só há preço via catálogo (poucos itens) ou por ID de anúncio já conhecido.
- **Frete real:** exige login do vendedor (`/shipping_options`), que o client_credentials não faz.
  Na calculadora o frete é uma **estimativa** por tabela. Comissão e custo fixo são 100% reais.
- **Categoria automática:** `precos.js` detecta a categoria pelo nome; nomes vagos podem errar a
  categoria (e portanto a comissão). Use `--sem-categoria` para a comissão padrão do ML.
- Não entram na conta: embalagem, imposto do seu regime e taxa de parcelamento no cartão.

## Fila de revisão (aprovação do gestor)

A aba **Publicar anúncio** não publica direto: ela valida o anúncio no Mercado Livre
e o envia para uma **fila de revisão**. Na aba **Revisor**, o gestor vê tudo como
será publicado (com custo, valor de venda e a média dos anúncios do ML bem
destacados), ajusta só o **preço final** e então **aprova** (aí sim publica de
verdade) ou **reprova**.

A fila é gravada num banco **SQLite** local (via `node:sqlite`, embutido no Node ≥ 22.13):

- Arquivo: `$DATA_DIR/revisao.db` (padrão `./data/revisao.db`).
- **Em produção (Docker/easypanel):** monte um **volume** em `/app/data` — ou aponte
  `DATA_DIR` para o caminho do mount. **Sem volume, a fila zera a cada redeploy**
  (mesmo comportamento do `.user-token.json`).

## Estrutura

```
calculadora-ml/
├── vite.config.js         React + mini-backend (plugin)
├── .env                   SUAS credenciais (local, no .gitignore)
├── src/App.jsx            calculadora, publicar e revisor
├── server/
│   ├── ml.js              client_credentials + listing_prices
│   ├── freight.js         estimativa de frete
│   ├── catalog.js         busca de catálogo (comparação de concorrente)
│   ├── publicar.js        montar/validar/publicar anúncio (API oficial)
│   ├── revisao.js         fila de aprovação (criar/listar/aprovar/reprovar)
│   ├── db.js              SQLite local (node:sqlite) em $DATA_DIR
│   └── vite-plugin-api.js rotas /api/*
└── scripts/
    ├── precos.js          simulador de preço mínimo (100% dos produtos)
    └── batch.js           comparação com concorrente (limitado)
```

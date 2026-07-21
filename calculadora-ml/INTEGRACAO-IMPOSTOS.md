# Integração de impostos — o que falta e por quê

Este documento explica **como o app trata os impostos hoje** e **o que precisa ser
ligado (banco de dados / ERP) para calcular o ICMS corretamente**.

Empresa: **FANTINELSHOP** — regime **Lucro Presumido**, comércio/varejo (papelaria).

---

## 1. O que o app JÁ calcula sozinho

Nas duas telas (Calculadora e Vantagens), a "Sobra pra você" já desconta
automaticamente os **impostos federais do Lucro Presumido**, sobre o preço de venda:

| Tributo | Alíquota | Base |
|---|---|---|
| PIS | 0,65% | preço de venda |
| COFINS | 3,00% | preço de venda |
| IRPJ | 1,20% (15% × presunção 8%) | preço de venda |
| CSLL | 1,08% (9% × presunção 12%) | preço de venda |
| **Total federal** | **5,93%** | preço de venda |

Isso é um número fixo, embutido no código em `src/App.jsx`:

```js
const IMPOSTO_PCT = 5.93 // Lucro Presumido federal (PIS+COFINS+IRPJ+CSLL)
```

> ⚠️ Não é apuração contábil oficial — é uma estimativa da carga federal.
> O IRPJ ainda tem adicional de 10% sobre o lucro presumido que exceder
> R$ 20.000/mês, que NÃO está embutido aqui.

---

## 2. O que o app AINDA NÃO calcula: o ICMS

O **ICMS não entra** no cálculo atual. E ele não pode ser um número fixo, porque
depende de três coisas que mudam item a item:

1. **Substituição tributária (ST)** — em papelaria/varejo, muitos produtos já vêm
   com o ICMS **pago na compra** (ST). Nesses itens, o ICMS na revenda é **zero**.
2. **NCM do produto** — cada classificação fiscal tem sua alíquota.
3. **Destino da venda** — venda dentro do estado tem uma alíquota; interestadual
   para consumidor final tem o **DIFAL** (partilha entre estados).

Por isso nem o Mercado Livre nem o app conseguem "adivinhar" o ICMS certo sozinhos.

---

## 3. A solução: ligar o app na base das NOTAS DE COMPRA (NF-e de entrada)

O XML da **NF-e de entrada** (a nota de quando você compra do fornecedor) tem,
**por produto**, exatamente o que falta para calcular o ICMS. Se o app tiver acesso
a esses dados, ele para de estimar e passa a calcular item a item.

### Campos necessários (por item da nota de compra)

| Campo NF-e | Para que serve |
|---|---|
| **CST / CSOSN** (`ICMS/*/CST` ou `CSOSN`) | Diz se o item é **ST**. Códigos 10/30/60/70 (ou CSOSN 201/202/500) = ST → ICMS já pago → **ICMS na revenda = 0**. |
| **NCM** (`prod/NCM`) | Define a alíquota de ICMS quando NÃO é ST. |
| **pICMS / vICMS** (`ICMS`) | Alíquota e valor reais de ICMS da compra. |
| **vICMSST / vBCST** | Valor do ICMS-ST já recolhido. |
| **CFOP** (`prod/CFOP`) | Tipo de operação (ajuda a validar ST/revenda). |
| **vProd + vIPI + impostos** | Custo real com impostos (melhor que custo médio). |
| **cProd / cEAN (GTIN)** | Chave para casar o item da nota com o produto do estoque. |

### Lógica que o app passaria a aplicar

```
para cada produto:
  se (item é ST pela nota de compra):
      ICMS_revenda = 0            # já foi pago na entrada
  senão:
      ICMS_revenda = preço_venda * aliquota_do_NCM   # (ver ressalva do DIFAL)
  imposto_total = 5,93% (federal) + ICMS_revenda
  sobra = preço - custo - taxas_ML - imposto_total
```

O ganho maior: **detectar ST automaticamente**. Como boa parte da papelaria é ST,
em muitos itens o ICMS real é zero — e nesses casos a "sobra" que o app já mostra
(só federal) está correta.

### Ressalva honesta (DIFAL)

Para vendas **interestaduais a consumidor final** (a maioria no Mercado Livre), o
ICMS do item NÃO-ST envolve o **DIFAL** (partilha origem/destino). Uma primeira
versão pode usar a alíquota interna do estado como aproximação e evoluir depois.
Detectar ST pela nota já resolve a maior parte dos casos.

---

## 4. O que é preciso para implementar

Escolher **uma** forma de acesso aos dados de compra:

- **A) API do ERP** (Bling, Tiny, Omie, etc.) — endpoint que liste as NF-e de
  entrada / produtos com dados fiscais. **Preferível** (dados já estruturados).
- **B) Conexão direta no banco de dados** onde o sistema guarda as notas —
  precisa de host, credenciais e o schema das tabelas de nota/item.
- **C) Pasta com os XMLs das NF-e de entrada** — o app lê e faz o parse dos XMLs.
  Funciona offline, mas exige manter os XMLs atualizados.

Em qualquer opção, o app casaria o produto da nota com o estoque pelo **GTIN
(código de barras)** — que já existe em ~96% da base (`produtos_novos.xlsx`).

### Segurança
- Credenciais de banco/ERP entram como **variáveis de ambiente** no easypanel
  (nunca no código nem no git), igual às credenciais do Mercado Livre.

---

## 5. Status atual

- [x] Impostos federais do Lucro Presumido (5,93%) — calculados automaticamente.
- [x] **ICMS por produto — IMPLEMENTADO** (opção B: conexão direta no Firebird do
  AUTOCOM/MGWare). O extrator lê as NF-e de entrada (`SAC_REC`/`SAC_RECI`), detecta
  ST e gera o mapa `impostos_app.json`. Na Calculadora, informar o código de barras
  (ou código do produto) traz o ICMS real: **0 se ST**, alíquota interna se não-ST.
  Pipeline em `../impostos/` (ver `impostos/README.md`).
- [ ] DIFAL interestadual — evolução futura, depois do ST.

### Números reais da base (extração de 2026-07)
- 63.461 produtos com nota de entrada · **96,2% com GTIN válido**.
- **~12% ST** (ICMS revenda = 0) na última compra; ~16,6% já foram ST alguma vez.
- **~88% NÃO-ST** → pagam ICMS normal (geralmente 17%). Ou seja, ao contrário do que
  se supunha, a maioria dos itens desta loja tem ICMS relevante na revenda.

> Antes de tratar qualquer número como definitivo, confirmar as alíquotas com o
> contador. O app é ferramenta de estimativa/decisão, não substitui a apuração fiscal.

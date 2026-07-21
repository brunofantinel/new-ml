# Impostos (ICMS/ST) — extração do ERP AUTOCOM/MGWare

Pipeline que lê as **NF-e de entrada** (notas de compra) do banco Firebird da loja e
gera, por produto, se o item é **Substituição Tributária (ST)** e qual o **ICMS na
revenda**. É o que o app da calculadora usa para descontar o ICMS certo.

## Banco
- Firebird 3, via TCP na porta **3050** (não trava a base de produção — só leitura).
- Servidor `192.168.0.4` → `G:\MGWare\db\autocom.fdb`.
- Credenciais por variável de ambiente (nunca no código):
  ```powershell
  setx FB_USER SYSDBA
  setx FB_PASSWORD "<senha>"
  ```
  (reabrir o terminal depois do `setx`).

## Tabelas usadas
- `SAC_PROD` — cadastro do produto (GTIN em `SAC_PROD_COD_BARRAS`, NCM em `..._NBM`,
  `..._PERC_ICMS`, `..._ATIVO`).
- `SAC_REC` / `SAC_RECI` — cabeçalho e **itens das notas de entrada** (compra). Em
  `SAC_RECI`: `CEAN` (GTIN limpo), `NCM`, `CFOP`, `PER_ICMS`, `VLR_ICMS_ST`,
  `VL_ST_RET`, `PERC_ST_RET`.

## Detecção de ST (por item da entrada mais recente)
É ST se qualquer um: CFOP de compra com ST (x403/x404/x405/x410/x411) **ou**
`VL_ST_RET > 0`/`PERC_ST_RET > 0` **ou** `VLR_ICMS_ST > 0`.
- ST → **ICMS revenda = 0** (já pago na compra).
- não-ST → alíquota interna configurada no produto (v1; DIFAL interestadual fica p/ v2).

## Como rodar (regerar os dados)
```powershell
py descobrir_schema.py      # opcional: mapeia tabelas/colunas
py extrair_impostos.py      # gera saida/impostos_por_produto.{json,csv} + resumo.txt
py gerar_mapa_app.py        # gera saida/impostos_app.json (só ativos, enxuto)
Copy-Item saida\impostos_app.json ..\calculadora-ml\public\impostos_app.json
```
Depois, no app: `npm run build`. O servidor lê `dist/impostos_app.json` e responde em
`GET /api/imposto?cod=<gtin-ou-codigo>`.

## Arquivos
- `_conexao.py` — conexão Firebird (lê `FB_USER`/`FB_PASSWORD`, charset ISO8859_1).
- `descobrir_schema.py` / `detalhar_tabelas.py` / `probe_st.py` — exploração.
- `extrair_impostos.py` — extrator principal.
- `gerar_mapa_app.py` — versão enxuta p/ o app.
- `saida/` — resultados (grandes; não precisa versionar o `.json` completo de 44 MB).

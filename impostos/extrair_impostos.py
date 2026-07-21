# -*- coding: utf-8 -*-
"""
Extrator de ICMS/ST por produto a partir das NOTAS DE ENTRADA (NF-e de compra).
Fonte: Firebird AUTOCOM/MGWare (somente leitura).

Regra central (o que o documento pede):
  Se o item foi COMPRADO com Substituicao Tributaria (ST), o ICMS ja foi pago na
  compra -> na REVENDA o ICMS = 0 (a "sobra" que o app mostra, so federal, esta certa).
  Se NAO for ST, aplica-se a aliquota interna de ICMS como aproximacao (v1),
  com a ressalva do DIFAL para venda interestadual a consumidor final.

Deteccao de ST (por item da entrada), na ordem de confianca:
  1. CFOP de compra sujeita a ST  (x403, x404, x405, x410, x411)
  2. VL_ST_RET > 0  (ST retido anteriormente)  ou  PERC_ST_RET > 0
  3. VLR_ICMS_ST > 0 (ST cobrado nesta compra)

Para cada produto usamos a ENTRADA MAIS RECENTE (melhor retrato atual),
mas tambem marcamos se o produto JA teve ST alguma vez.

Saidas (pasta impostos/saida):
  - impostos_por_produto.json  -> mapa por GTIN + por cod_prod (consumo pelo app)
  - impostos_por_produto.csv   -> versao planilha
  - resumo.txt                 -> cobertura de ST e estatisticas
"""
import sys, os, json, csv
sys.path.insert(0, r"c:\Users\estoque\Desktop\mll\impostos")
from _conexao import conectar

SAIDA = os.path.join(os.path.dirname(__file__), "saida")
os.makedirs(SAIDA, exist_ok=True)

# CFOPs de COMPRA sujeita a ST (o segundo/terceiro digito importa: x40x)
CFOP_ST = {
    1403, 2403, 1404, 2404, 1405, 2405,
    1410, 2410, 1411, 2411,
    1401, 2401,  # compra p/ industrializacao sujeita a ST
}
# CFOPs que NAO sao compra de mercadoria p/ revenda (remessa/consignacao/transf):
# nao servem de sinal fiscal de revenda -> ignorados na escolha da entrada.
CFOP_IGNORAR = {
    1917, 2917, 5917, 6917,  # remessa p/ deposito/consignacao
    1910, 2910, 5910, 6910,  # bonificacao/brinde
    1949, 2949,              # outra entrada nao especificada
}


def gtin_valido(g):
    """Valida digito verificador de EAN-13/EAN-8/GTIN-14 (texto so-digitos)."""
    if not g or not g.isdigit():
        return False
    if len(g) not in (8, 12, 13, 14):
        return False
    dig = [int(c) for c in g]
    check = dig[-1]
    corpo = dig[:-1][::-1]
    soma = 0
    for i, d in enumerate(corpo):
        soma += d * (3 if i % 2 == 0 else 1)
    calc = (10 - soma % 10) % 10
    return calc == check


def formata_cod_barras(valor):
    """SAC_PROD_COD_BARRAS vem como DOUBLE. Converte p/ GTIN texto se plausivel."""
    if valor is None:
        return None
    try:
        n = int(round(float(valor)))
    except (ValueError, TypeError):
        return None
    if n <= 0:
        return None
    s = str(n)
    # sinteticos do ERP (999000..., ou = codigo do produto curto) nao sao GTIN
    if s.startswith("999000") or len(s) < 8:
        return None
    return s


def cfop_e_st(cfop):
    if cfop is None:
        return False
    return int(cfop) in CFOP_ST


def item_e_st(cfop, vlr_icms_st, vl_st_ret, perc_st_ret):
    if cfop_e_st(cfop):
        return True
    if (vl_st_ret or 0) > 0 or (perc_st_ret or 0) > 0:
        return True
    if (vlr_icms_st or 0) > 0:
        return True
    return False


def main():
    con = conectar()
    cur = con.cursor()

    print("Lendo itens de entrada + data da nota (pode levar alguns segundos)...")
    # Join item->nota para pegar a data de entrada; ordena por produto e data
    # para reduzir em Python mantendo a entrada mais recente.
    cur.execute(
        """
        SELECT i.SAC_RECI_COD_PROD,
               i.SAC_RECI_CEAN,
               i.SAC_RECI_NCM,
               i.SAC_RECI_CEST,
               i.SAC_RECI_CFOP,
               i.SAC_RECI_PER_ICMS,
               i.SAC_RECI_VLR_ICMS_ST,
               i.SAC_RECI_VL_ST_RET,
               i.SAC_RECI_PERC_ST_RET,
               n.SAC_REC_DT_ENTRADA
        FROM SAC_RECI i
        JOIN SAC_REC n
          ON n.SAC_REC_LOJA   = i.SAC_RECI_LOJA
         AND n.SAC_REC_FORNEC = i.SAC_RECI_FORNEC
         AND n.SAC_REC_DOC    = i.SAC_RECI_DOC
        WHERE i.SAC_RECI_COD_PROD IS NOT NULL
        """
    )

    # reduz: por cod_prod guarda a entrada valida mais recente + "ja teve ST"
    atual = {}      # cod_prod -> dict da entrada escolhida
    ja_teve_st = {} # cod_prod -> bool
    total_itens = 0
    for row in cur:
        (cod, cean, ncm, cest, cfop, per_icms,
         v_st, v_st_ret, p_st_ret, dt) = row
        total_itens += 1
        cod = int(round(cod))

        st = item_e_st(cfop, v_st, v_st_ret, p_st_ret)
        if st:
            ja_teve_st[cod] = True
        else:
            ja_teve_st.setdefault(cod, False)

        # ignora CFOPs que nao sao compra de revenda ao escolher "entrada atual"
        if cfop is not None and int(cfop) in CFOP_IGNORAR:
            continue

        cand = {
            "cean": (cean or "").strip(),
            "ncm": (ncm or "").strip(),
            "cest": cest,
            "cfop": cfop,
            "per_icms": float(per_icms or 0),
            "st": st,
            "dt": dt,
        }
        ant = atual.get(cod)
        if ant is None or (dt is not None and (ant["dt"] is None or dt > ant["dt"])):
            atual[cod] = cand

    print(f"  itens lidos: {total_itens:,} | produtos com entrada: {len(atual):,}")

    print("Lendo cadastro de produtos (SAC_PROD)...")
    cur.execute(
        """
        SELECT SAC_PROD_COD, SAC_PROD_DESCR, SAC_PROD_COD_BARRAS,
               SAC_PROD_NBM, SAC_PROD_CEST, SAC_PROD_PERC_ICMS,
               SAC_PROD_PERC_SUBTRIB, SAC_PROD_ATIVO
        FROM SAC_PROD
        """
    )
    prod = {}
    for cod, descr, barras, nbm, cest, perc_icms, perc_sub, ativo in cur:
        prod[int(round(cod))] = {
            "descr": (descr or "").strip(),
            "cod_barras": formata_cod_barras(barras),
            "ncm_cad": (nbm or "").strip(),
            "cest_cad": cest,
            "perc_icms_cad": float(perc_icms or 0),
            "perc_subtrib_cad": float(perc_sub or 0),
            "ativo": (ativo or "").strip().upper() == "S",
        }

    # monta registro final por produto
    registros = []
    for cod, ent in atual.items():
        p = prod.get(cod, {})
        st = ent["st"]

        # GTIN: prioriza CEAN da nota; fallback = cod_barras do cadastro
        gtin = ent["cean"] if gtin_valido(ent["cean"]) else None
        if not gtin:
            cb = p.get("cod_barras")
            gtin = cb if gtin_valido(cb or "") else None

        ncm = ent["ncm"] or p.get("ncm_cad", "")

        # ICMS na revenda (v1): ST -> 0 ; senao aliquota interna configurada
        if st:
            icms_venda = 0.0
        else:
            icms_venda = p.get("perc_icms_cad", 0.0)

        registros.append({
            "cod_prod": cod,
            "gtin": gtin,
            "descr": p.get("descr", ""),
            "ncm": ncm,
            "cest": ent["cest"] or p.get("cest_cad"),
            "st": st,
            "ja_teve_st": ja_teve_st.get(cod, False),
            "cfop_entrada": ent["cfop"],
            "icms_compra_pct": round(ent["per_icms"], 2),
            "icms_venda_pct": round(icms_venda, 2),
            "ativo": p.get("ativo", None),
            "dt_entrada": ent["dt"].isoformat() if ent["dt"] else None,
        })

    con.close()

    # ---- grava JSON (mapa por gtin e por cod_prod) ----
    por_gtin, por_cod = {}, {}
    for r in registros:
        por_cod[str(r["cod_prod"])] = r
        if r["gtin"]:
            por_gtin[r["gtin"]] = r
    with open(os.path.join(SAIDA, "impostos_por_produto.json"), "w", encoding="utf-8") as f:
        json.dump({"por_gtin": por_gtin, "por_cod_prod": por_cod},
                  f, ensure_ascii=False, indent=1)

    # ---- grava CSV ----
    campos = ["cod_prod", "gtin", "descr", "ncm", "cest", "st", "ja_teve_st",
              "cfop_entrada", "icms_compra_pct", "icms_venda_pct", "ativo", "dt_entrada"]
    with open(os.path.join(SAIDA, "impostos_por_produto.csv"), "w",
              encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=campos, delimiter=";")
        w.writeheader()
        for r in registros:
            w.writerow(r)

    # ---- resumo ----
    n = len(registros)
    n_st = sum(1 for r in registros if r["st"])
    n_ever = sum(1 for r in registros if r["ja_teve_st"])
    n_ever_ativos = sum(1 for r in registros if r["ja_teve_st"] and r["ativo"])
    n_gtin = sum(1 for r in registros if r["gtin"])
    n_ativos = sum(1 for r in registros if r["ativo"])
    n_st_ativos = sum(1 for r in registros if r["st"] and r["ativo"])
    linhas = [
        "RESUMO DA EXTRACAO DE ICMS/ST (fonte: NF-e de entrada AUTOCOM)",
        "=" * 62,
        f"Produtos com pelo menos 1 entrada : {n:,}",
        f"  com GTIN valido                 : {n_gtin:,} ({n_gtin/n*100:.1f}%)",
        f"  ATIVOS no cadastro              : {n_ativos:,}",
        "",
        f"ST na ULTIMA compra (ICMS rev.=0) : {n_st:,} ({n_st/n*100:.1f}%)  | ativos: {n_st_ativos:,}",
        f"JA teve ST em alguma compra       : {n_ever:,} ({n_ever/n*100:.1f}%)  | ativos: {n_ever_ativos:,}",
        f"NAO-ST na ultima compra           : {n-n_st:,} ({(n-n_st)/n*100:.1f}%)",
        "",
        "  (usamos ST-da-ultima-compra como sinal principal; 'ja teve ST' e o",
        "   teto: produtos cuja categoria costuma ser ST em algum fornecedor/UF.)",
        "",
        "Interpretacao:",
        "  - Nos produtos ST a 'sobra' atual do app (so federal 5,93%) ja esta",
        "    correta, pois o ICMS foi pago na compra e nao incide na revenda.",
        "  - Nos NAO-ST, o app deve descontar tambem a aliquota de ICMS (v1 usa a",
        "    interna; DIFAL interestadual fica p/ v2).",
        "",
        "Arquivos gerados em impostos/saida/:",
        "  impostos_por_produto.json (mapa p/ o app)  |  .csv (planilha)",
    ]
    resumo = "\n".join(linhas)
    with open(os.path.join(SAIDA, "resumo.txt"), "w", encoding="utf-8") as f:
        f.write(resumo + "\n")
    print("\n" + resumo)


if __name__ == "__main__":
    main()

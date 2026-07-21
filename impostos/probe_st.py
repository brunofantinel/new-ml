# -*- coding: utf-8 -*-
"""
Sonda de realidade dos dados (somente leitura, agregados + amostras pequenas).
Objetivo: confirmar COMO a Substituicao Tributaria (ST) aparece nas notas de
entrada, antes de escrever o extrator definitivo.
"""
import sys
sys.path.insert(0, r"c:\Users\estoque\Desktop\mll\impostos")
from _conexao import conectar


def q(cur, sql):
    cur.execute(sql)
    return cur.fetchall()


def main():
    con = conectar()
    cur = con.cursor()

    print("=== SAC_RECI: indicadores de ST (contagens) ===")
    for rotulo, cond in [
        ("total itens", "1=1"),
        ("VLR_ICMS_ST > 0", "SAC_RECI_VLR_ICMS_ST > 0"),
        ("VL_ST_RET > 0 (ST ja retido)", "SAC_RECI_VL_ST_RET > 0"),
        ("PERC_ST_RET > 0", "SAC_RECI_PERC_ST_RET > 0"),
        ("PER_ICMS = 0", "SAC_RECI_PER_ICMS = 0"),
        ("CSOSN in (201,202,203,500,900)", "SAC_RECI_CSOSN IN (201,202,203,500,900)"),
    ]:
        n = q(cur, f"SELECT COUNT(*) FROM SAC_RECI WHERE {cond}")[0][0]
        print(f"  {rotulo:35} {n:>10,}")

    print("\n=== CFOP mais comuns na entrada (top 15) ===")
    rows = q(cur,
        "SELECT FIRST 15 SAC_RECI_CFOP, COUNT(*) c "
        "FROM SAC_RECI GROUP BY SAC_RECI_CFOP ORDER BY c DESC")
    for cfop, c in rows:
        print(f"  CFOP {cfop}: {c:,}")

    print("\n=== CSOSN mais comuns (top 10) ===")
    rows = q(cur,
        "SELECT FIRST 10 SAC_RECI_CSOSN, COUNT(*) c "
        "FROM SAC_RECI GROUP BY SAC_RECI_CSOSN ORDER BY c DESC")
    for cs, c in rows:
        print(f"  CSOSN {cs}: {c:,}")

    print("\n=== Amostra de 8 itens COM ST (ST_RET) ===")
    rows = q(cur,
        "SELECT FIRST 8 SAC_RECI_CEAN, SAC_RECI_NCM, SAC_RECI_CFOP, "
        "SAC_RECI_CSOSN, SAC_RECI_PER_ICMS, SAC_RECI_VLR_ICMS_ST, "
        "SAC_RECI_VL_ST_RET, SAC_RECI_PERC_ST_RET "
        "FROM SAC_RECI WHERE SAC_RECI_VL_ST_RET > 0")
    print("  CEAN | NCM | CFOP | CSOSN | pICMS | vICMS_ST | vST_RET | %ST_RET")
    for r in rows:
        print("  ", " | ".join(str(x) for x in r))

    print("\n=== Amostra de 8 itens SEM ST (ICMS normal) ===")
    rows = q(cur,
        "SELECT FIRST 8 SAC_RECI_CEAN, SAC_RECI_NCM, SAC_RECI_CFOP, "
        "SAC_RECI_CSOSN, SAC_RECI_PER_ICMS, SAC_RECI_VLR_ICMS_ST, SAC_RECI_VL_ST_RET "
        "FROM SAC_RECI WHERE SAC_RECI_PER_ICMS > 0 AND SAC_RECI_VLR_ICMS_ST = 0 "
        "AND SAC_RECI_VL_ST_RET = 0")
    print("  CEAN | NCM | CFOP | CSOSN | pICMS | vICMS_ST | vST_RET")
    for r in rows:
        print("  ", " | ".join(str(x) for x in r))

    # Como o codigo de barras esta guardado no produto (DOUBLE)
    print("\n=== SAC_PROD: amostra de COD_BARRAS/NBM/PERC_ICMS/CSOSN ===")
    rows = q(cur,
        "SELECT FIRST 6 SAC_PROD_COD, SAC_PROD_COD_BARRAS, SAC_PROD_NBM, "
        "SAC_PROD_PERC_ICMS, SAC_PROD_CSOSN, SAC_PROD_PERC_SUBTRIB, SAC_PROD_ATIVO "
        "FROM SAC_PROD WHERE SAC_PROD_COD_BARRAS > 0")
    for r in rows:
        print("  ", r)

    con.close()


if __name__ == "__main__":
    main()

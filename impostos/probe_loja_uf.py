# -*- coding: utf-8 -*-
"""Descobre a UF da loja (origem) e valida o pICMS de compra (credito)."""
import sys
sys.path.insert(0, r"c:\Users\estoque\Desktop\mll\impostos")
from _conexao import conectar


def q(cur, sql):
    cur.execute(sql)
    return cur.fetchall()


def main():
    con = conectar()
    cur = con.cursor()

    # 1) procura tabelas que devem guardar o cadastro da empresa/loja
    print("=== tabelas candidatas a EMPRESA/LOJA/PARAMETRO ===")
    rows = q(cur,
        "SELECT TRIM(rdb$relation_name) FROM rdb$relations "
        "WHERE rdb$system_flag=0 AND rdb$view_blr IS NULL "
        "AND (rdb$relation_name LIKE '%LOJA%' OR rdb$relation_name LIKE '%EMPRESA%' "
        "OR rdb$relation_name LIKE '%FILIAL%' OR rdb$relation_name LIKE '%PRM%' "
        "OR rdb$relation_name LIKE 'PARAM%' OR rdb$relation_name LIKE '%CONFIG%') "
        "ORDER BY 1")
    for r in rows:
        print("  ", r[0])

    # 2) colunas com UF / ESTADO em qualquer tabela pequena
    print("\n=== colunas com 'UF'/'ESTADO' ===")
    rows = q(cur,
        "SELECT TRIM(rf.rdb$relation_name), TRIM(rf.rdb$field_name) "
        "FROM rdb$relation_fields rf "
        "JOIN rdb$relations r ON r.rdb$relation_name=rf.rdb$relation_name "
        "WHERE r.rdb$system_flag=0 AND (rf.rdb$field_name LIKE '%UF%' "
        "OR rf.rdb$field_name LIKE '%ESTADO%') ORDER BY 1,2")
    for tab, col in rows:
        print(f"  {tab}.{col}")

    # 3) distribuicao do pICMS de compra (credito) nas entradas nao-ST
    print("\n=== pICMS de compra (credito) — entradas com ICMS destacado ===")
    rows = q(cur,
        "SELECT SAC_RECI_PER_ICMS, COUNT(*) c FROM SAC_RECI "
        "WHERE SAC_RECI_PER_ICMS > 0 GROUP BY SAC_RECI_PER_ICMS ORDER BY c DESC ROWS 12")
    for a, c in rows:
        print(f"  {a}% : {c:,}")

    con.close()


if __name__ == "__main__":
    main()

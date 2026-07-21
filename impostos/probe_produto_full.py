# -*- coding: utf-8 -*-
"""Descobre as tabelas de fornecedor, grupo/subgrupo e estoque p/ montar o
'tudo do produto'. Testa com um codigo real."""
import sys
sys.path.insert(0, r"c:\Users\estoque\Desktop\mll\impostos")
from _conexao import conectar

COD = 4346  # produto de teste (visto no estoq.csv)


def cols(cur, tab):
    cur.execute(
        "SELECT TRIM(rf.rdb$field_name) FROM rdb$relation_fields rf "
        "WHERE rf.rdb$relation_name=? ORDER BY rf.rdb$field_position", (tab,))
    return [r[0] for r in cur.fetchall()]


def existe(cur, tab):
    cur.execute("SELECT COUNT(*) FROM rdb$relations WHERE rdb$relation_name=?", (tab,))
    return cur.fetchone()[0] > 0


def main():
    con = conectar()
    cur = con.cursor()

    for tab in ["FORNECEDOR", "SAC_GRUP", "SAC_SUBG", "GRUPO", "SUBGRUPO",
                "SAC_GRUPO", "SAC_SUBGRUPO", "CACHE_EST", "SAC_LOJA"]:
        if existe(cur, tab):
            print(f"=== {tab} ===")
            print("  ", cols(cur, tab)[:25])

    # grupo/subgrupo do produto de teste
    print("\n=== produto teste (grupo/subg/fornec) ===")
    cur.execute("SELECT SAC_PROD_GRUP, SAC_PROD_SUBG, SAC_PROD_FORNECEDOR FROM SAC_PROD WHERE SAC_PROD_COD=?", (COD,))
    print("  ", cur.fetchone())

    # tenta achar nome do grupo
    for tab, codc, namec in [("SAC_GRUP", None, None), ("SAC_SUBG", None, None)]:
        if existe(cur, tab):
            print(f"  amostra {tab}:", cols(cur, tab)[:6])
            try:
                cur.execute(f"SELECT FIRST 2 * FROM {tab}")
                for r in cur.fetchall():
                    print("    ", r[:5])
            except Exception as e:
                print("    err", e)

    # estoque via CACHE_EST
    if existe(cur, "CACHE_EST"):
        try:
            cur.execute("SELECT SUM(CACHE_EST_QTDE) FROM CACHE_EST WHERE CACHE_EST_PRODUTO=?", (COD,))
            print("\n  estoque CACHE_EST soma:", cur.fetchone()[0])
        except Exception as e:
            print("\n  CACHE_EST err:", e)

    con.close()


if __name__ == "__main__":
    main()

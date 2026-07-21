# -*- coding: utf-8 -*-
"""Dump de colunas (com tipo) e contagem de linhas das tabelas fiscais chave."""
import sys
sys.path.insert(0, r"c:\Users\estoque\Desktop\mll\impostos")
from _conexao import conectar

ALVO = ["SAC_PROD", "SAC_PROD_UF", "SAC_REC", "SAC_RECI", "SAC_CAMPI", "NCM"]

# mapa de tipo Firebird
TIPOS = {7: "SMALLINT", 8: "INTEGER", 16: "BIGINT/NUMERIC", 10: "FLOAT",
         27: "DOUBLE", 12: "DATE", 13: "TIME", 35: "TIMESTAMP",
         14: "CHAR", 37: "VARCHAR", 261: "BLOB", 23: "BOOLEAN"}


def main():
    con = conectar()
    cur = con.cursor()
    for tab in ALVO:
        print(f"\n===== {tab} =====")
        cur.execute(
            "SELECT TRIM(rf.rdb$field_name), f.rdb$field_type, "
            "       f.rdb$field_length, f.rdb$field_scale, f.rdb$field_sub_type "
            "FROM rdb$relation_fields rf "
            "JOIN rdb$fields f ON f.rdb$field_name = rf.rdb$field_source "
            "WHERE rf.rdb$relation_name = ? "
            "ORDER BY rf.rdb$field_position",
            (tab,),
        )
        cols = cur.fetchall()
        if not cols:
            print("  (tabela nao encontrada)")
            continue
        for nome, tp, ln, sc, sub in cols:
            t = TIPOS.get(tp, f"tp{tp}")
            extra = ""
            if sc and sc < 0:
                extra = f"({ln},{-sc})" if tp == 16 else f"(scale {sc})"
            elif tp in (14, 37):
                extra = f"({ln})"
            print(f"  {nome:32} {t}{extra}")
        try:
            cur.execute(f"SELECT COUNT(*) FROM {tab}")
            print(f"  -> linhas: {cur.fetchone()[0]:,}")
        except Exception as e:
            print(f"  -> contagem falhou: {e}")
    con.close()


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""Le a tabela UF do ERP (aliquotas por estado) e a UF da propria loja."""
import sys
sys.path.insert(0, r"c:\Users\estoque\Desktop\mll\impostos")
from _conexao import conectar


def main():
    con = conectar()
    cur = con.cursor()

    print("=== UF (aliquotas do ERP) ===")
    cur.execute("SELECT UF_COD, UF_SIGLA, UF_NOME, UF_ICMS, UF_ICMS_INTER, UF_ST FROM UF ORDER BY UF_SIGLA")
    for cod, sigla, nome, icms, inter, st in cur.fetchall():
        print(f"  {sigla} (cod {cod}) interna={icms} inter={inter} st={st}  {nome}")

    print("\n=== PRM (parametros da empresa) — UF ===")
    try:
        cur.execute("SELECT UF FROM PRM")
        for r in cur.fetchall():
            print("  PRM.UF =", r[0])
    except Exception as e:
        print("  falhou:", e)

    print("\n=== SAC_LOJA (colunas) ===")
    cur.execute(
        "SELECT TRIM(rf.rdb$field_name) FROM rdb$relation_fields rf "
        "WHERE rf.rdb$relation_name='SAC_LOJA' ORDER BY rf.rdb$field_position")
    cols = [r[0] for r in cur.fetchall()]
    print("  ", cols)
    # tenta achar UF/endereco da loja
    ufcols = [c for c in cols if 'UF' in c or 'EST' in c or 'CIDADE' in c or 'NOME' in c or 'RAZAO' in c]
    if ufcols:
        sel = ", ".join(ufcols[:8])
        try:
            cur.execute(f"SELECT {sel} FROM SAC_LOJA ROWS 5")
            print("  amostra:", ufcols[:8])
            for r in cur.fetchall():
                print("   ", r)
        except Exception as e:
            print("  amostra falhou:", e)

    con.close()


if __name__ == "__main__":
    main()

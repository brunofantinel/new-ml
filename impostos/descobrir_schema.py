# -*- coding: utf-8 -*-
"""
Descoberta do schema do AUTOCOM/MGWare (somente leitura).
Lista tabelas e colunas que interessam para o calculo de ICMS:
- Produtos (com GTIN/EAN, NCM, CEST)
- Notas de ENTRADA (compra) e seus itens (CST/CSOSN, pICMS, vICMS, vICMSST, CFOP)

Nao le dados de negocio ainda; so o dicionario de dados do proprio Firebird.
"""
import sys
sys.path.insert(0, r"c:\Users\estoque\Desktop\mll\impostos")
from _conexao import conectar

# palavras que denunciam a finalidade de uma tabela/coluna
CHAVES_TABELA = [
    "PRODUT", "ITEM", "ESTOQU", "MERCAD",
    "NOTA", "NF", "ENTRAD", "COMPRA", "FISCAL", "NFE", "XML",
]
CHAVES_COLUNA = [
    "EAN", "GTIN", "BARRA", "NCM", "CEST",
    "CST", "CSOSN", "CFOP", "ICMS", "ALIQ", "PICMS", "VICMS", "ST",
]


def main():
    con = conectar()
    cur = con.cursor()

    # 1) todas as tabelas de usuario
    cur.execute(
        "SELECT TRIM(rdb$relation_name) "
        "FROM rdb$relations "
        "WHERE rdb$system_flag = 0 AND rdb$view_blr IS NULL "
        "ORDER BY 1"
    )
    tabelas = [r[0] for r in cur.fetchall()]
    print(f"# Total de tabelas de usuario: {len(tabelas)}\n")

    # 2) tabelas candidatas por nome
    print("=== TABELAS CANDIDATAS (por nome) ===")
    candidatas = [t for t in tabelas if any(k in t for k in CHAVES_TABELA)]
    for t in candidatas:
        print("  ", t)

    # 3) colunas fiscais em qualquer tabela
    print("\n=== COLUNAS FISCAIS ENCONTRADAS (tabela.coluna) ===")
    cur.execute(
        "SELECT TRIM(rf.rdb$relation_name), TRIM(rf.rdb$field_name) "
        "FROM rdb$relation_fields rf "
        "JOIN rdb$relations r ON r.rdb$relation_name = rf.rdb$relation_name "
        "WHERE r.rdb$system_flag = 0 "
        "ORDER BY 1,2"
    )
    todas_cols = cur.fetchall()
    achados = {}
    for tab, col in todas_cols:
        if any(k in col for k in CHAVES_COLUNA):
            achados.setdefault(tab, []).append(col)
    for tab in sorted(achados):
        print(f"  {tab}: {', '.join(achados[tab])}")

    con.close()


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""
Gera um mapa ENXUTO para o app (so produtos ATIVOS, campos minimos),
a partir do impostos_por_produto.json completo.
Saida: impostos/saida/impostos_app.json  (chaveado por GTIN e por cod_prod)
"""
import json, os

SAIDA = os.path.join(os.path.dirname(__file__), "saida")
completo = json.load(open(os.path.join(SAIDA, "impostos_por_produto.json"), encoding="utf-8"))

por_gtin, por_cod = {}, {}
for r in completo["por_cod_prod"].values():
    if not r.get("ativo"):
        continue
    slim = {
        "st": r["st"],
        "icms": r["icms_venda_pct"],   # % de ICMS na revenda (0 se ST)
        "ncm": r["ncm"],
        "d": r["descr"][:60],          # descricao curta p/ conferencia
    }
    por_cod[str(r["cod_prod"])] = slim
    if r["gtin"]:
        por_gtin[r["gtin"]] = slim

out = {
    "_meta": {
        "fonte": "AUTOCOM/MGWare NF-e de entrada",
        "regra": "ICMS revenda = 0 quando ST; senao aliquota interna (v1, sem DIFAL)",
        "produtos_ativos": len(por_cod),
        "com_gtin": len(por_gtin),
    },
    "por_gtin": por_gtin,
    "por_cod": por_cod,
}
dest = os.path.join(SAIDA, "impostos_app.json")
json.dump(out, open(dest, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"gerado {dest}")
print(f"  ativos: {len(por_cod):,} | com gtin: {len(por_gtin):,} | "
      f"tamanho: {os.path.getsize(dest)/1024:.0f} KB")

# -*- coding: utf-8 -*-
"""
Agrega os dados por NCM a partir do impostos_por_produto.json (completo).
Para cada NCM diz se ELE COSTUMA SER ST na pratica da loja e qual o credito
tipico de ICMS na compra. Assim, informando so o NCM, o app ja acerta a maioria.

Saida: impostos/saida/impostos_ncm.json  ->  copiar p/ calculadora-ml/public/
"""
import json, os
from collections import defaultdict
from statistics import median

SAIDA = os.path.join(os.path.dirname(__file__), "saida")
completo = json.load(open(os.path.join(SAIDA, "impostos_por_produto.json"), encoding="utf-8"))

# agrega por NCM (8 digitos, so numeros)
por_ncm = defaultdict(lambda: {"n": 0, "st": 0, "creditos": []})
for r in completo["por_cod_prod"].values():
    ncm = "".join(ch for ch in str(r.get("ncm") or "") if ch.isdigit())
    if len(ncm) != 8:
        continue
    g = por_ncm[ncm]
    g["n"] += 1
    if r["st"]:
        g["st"] += 1
    else:
        # credito = ICMS da compra dos itens NAO-ST (nos ST o credito nao se usa)
        if r["icms_compra_pct"]:
            g["creditos"].append(r["icms_compra_pct"])

saida = {}
for ncm, g in por_ncm.items():
    share = g["st"] / g["n"] if g["n"] else 0
    cred = round(median(g["creditos"]), 2) if g["creditos"] else 0
    saida[ncm] = {
        "st": share >= 0.5,          # maioria dos produtos desse NCM e ST
        "share": round(share, 2),     # fracao ST (transparencia)
        "ic": cred,                   # credito tipico de ICMS na compra
        "n": g["n"],                  # quantos produtos sustentam a estatistica
    }

out = {
    "_meta": {
        "fonte": "agregado por NCM das NF-e de entrada (AUTOCOM)",
        "regra": "st = maioria dos produtos do NCM comprada com ST; ic = credito mediano",
        "ncms": len(saida),
    },
    "por_ncm": saida,
}
dest = os.path.join(SAIDA, "impostos_ncm.json")
json.dump(out, open(dest, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"gerado {dest}")
print(f"  NCMs: {len(saida):,} | tamanho: {os.path.getsize(dest)/1024:.0f} KB")
# amostra
for ncm in list(saida)[:5]:
    print("  ", ncm, saida[ncm])

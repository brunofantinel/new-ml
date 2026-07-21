# -*- coding: utf-8 -*-
"""
Agente local do ERP (AUTOCOM/MGWare) — SOMENTE LEITURA.

Roda numa maquina DENTRO da rede da loja (que alcanca o Firebird 192.168.0.4).
Expoe um HTTP simples para consultar UM produto por codigo interno:

    GET /produto/<codigo>      (header  X-API-Key: <token>)
    GET /health

O app na internet (easypanel) chama este agente atraves de um tunel seguro
(Cloudflare Tunnel) — ver README.md. Nada aqui escreve na base.

Configuracao por variavel de ambiente:
    FB_HOST      (padrao 192.168.0.4)
    FB_PORT      (padrao 3050)
    FB_DBPATH    (padrao G:\\MGWare\\db\\autocom.fdb)
    FB_USER      (padrao SYSDBA)
    FB_PASSWORD  (obrigatorio)
    FB_CLIENT    (padrao C:\\Program Files\\Firebird\\Firebird_3_0\\fbclient.dll)
    AGENT_TOKEN  (obrigatorio — senha simples que o app precisa mandar)
    AGENT_PORT   (padrao 8799)
"""
import os
import json
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HOST = os.environ.get("FB_HOST", "192.168.0.4")
PORT = int(os.environ.get("FB_PORT", "3050"))
DBPATH = os.environ.get("FB_DBPATH", r"G:\MGWare\db\autocom.fdb")
USER = os.environ.get("FB_USER", "SYSDBA")
PASSWORD = os.environ.get("FB_PASSWORD", "")
FBCLIENT = os.environ.get("FB_CLIENT", r"C:\Program Files\Firebird\Firebird_3_0\fbclient.dll")
CHARSET = os.environ.get("FB_CHARSET", "ISO8859_1")
TOKEN = os.environ.get("AGENT_TOKEN", "")
AGENT_PORT = int(os.environ.get("AGENT_PORT", "8799"))

# CFOPs de compra sujeita a ST e os que ignoramos ao escolher a entrada "atual"
CFOP_ST = {1401, 2401, 1403, 2403, 1404, 2404, 1405, 2405, 1410, 2410, 1411, 2411}
CFOP_IGNORAR = {1917, 2917, 5917, 6917, 1910, 2910, 5910, 6910, 1949, 2949}


def conectar():
    from firebird.driver import connect, driver_config
    if not PASSWORD:
        raise RuntimeError("FB_PASSWORD nao definido.")
    driver_config.fb_client_library.value = FBCLIENT
    return connect(f"{HOST}/{PORT}:{DBPATH}", user=USER, password=PASSWORD, charset=CHARSET)


def fmt_barras(v):
    if v is None:
        return None
    try:
        n = int(round(float(v)))
    except (ValueError, TypeError):
        return None
    if n <= 0:
        return None
    s = str(n)
    return None if s.startswith("999000") or len(s) < 8 else s


def num(v):
    """Decimal/float -> float JSON-serializavel."""
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def entrada_e_st(cfop, v_st, v_st_ret, p_st_ret):
    if cfop is not None and int(cfop) in CFOP_ST:
        return True
    return (v_st_ret or 0) > 0 or (p_st_ret or 0) > 0 or (v_st or 0) > 0


# colunas do SAC_PROD que interessam (rotulo -> coluna)
CAMPOS = [
    ("SAC_PROD_DESCR", "descricao"),
    ("SAC_PROD_DESCR_RES", "descricao_resumida"),
    ("SAC_PROD_REF", "referencia"),
    ("SAC_PROD_MARCA", "marca"),
    ("SAC_PROD_COD_BARRAS", "_barras"),
    ("SAC_PROD_NBM", "ncm"),
    ("SAC_PROD_CEST", "cest"),
    ("SAC_PROD_UM", "unidade"),
    ("SAC_PROD_ULT_CUSTO", "_ult_custo"),
    ("SAC_PROD_CUSTO_MEDIO", "_custo_medio"),
    ("SAC_PROD_PERC_ICMS", "_icms"),
    ("SAC_PROD_CSOSN", "_csosn"),
    ("SAC_PROD_PERC_SUBTRIB", "_subtrib"),
    ("SAC_PROD_PERC_PIS", "_pis"),
    ("SAC_PROD_PERC_COFINS", "_cofins"),
    ("SAC_PROD_IPI", "_ipi"),
    ("SAC_PROD_CST_IPI", "_cst_ipi"),
    ("SAC_PROD_CFOP", "_cfop"),
    ("SAC_PROD_PESO_UNIT", "_peso_unit"),
    ("SAC_PROD_PESO_EMB", "_peso_emb"),
    ("SAC_PROD_ALTURA", "_altura"),
    ("SAC_PROD_LARGURA", "_largura"),
    ("SAC_PROD_COMPRIMENTO", "_comprimento"),
    ("SAC_PROD_ATIVO", "_ativo"),
    ("SAC_PROD_FORA_LINHA", "_fora_linha"),
    ("SAC_PROD_DT_CADASTRO", "_dt_cad"),
    ("SAC_PROD_OBSERV", "observacao"),
    ("SAC_PROD_FORNECEDOR", "_fornec_cod"),
]


def consultar_produto(cod):
    con = conectar()
    try:
        cur = con.cursor()
        colnames = ", ".join(f"p.{c}" for c, _ in CAMPOS)
        cur.execute(
            f"SELECT {colnames}, g.SAC_GRUP_DESCR, sg.SAC_SUBG_DESCR, f.FORNECEDOR_NOME "
            "FROM SAC_PROD p "
            "LEFT JOIN SAC_GRUP g ON g.SAC_GRUP_COD = p.SAC_PROD_GRUP "
            "LEFT JOIN SAC_SUBG sg ON sg.SAC_SUBG_COD = p.SAC_PROD_SUBG AND sg.SAC_SUBG_GRUP = p.SAC_PROD_GRUP "
            "LEFT JOIN FORNECEDOR f ON f.FORNEC_COD = p.SAC_PROD_FORNECEDOR "
            "WHERE p.SAC_PROD_COD = ?",
            (cod,),
        )
        row = cur.fetchone()
        if not row:
            return {"encontrado": False}

        d = {}
        for i, (_, rot) in enumerate(CAMPOS):
            d[rot] = row[i]
        grupo, subgrupo, fornecedor = row[len(CAMPOS)], row[len(CAMPOS) + 1], row[len(CAMPOS) + 2]

        # entrada mais recente (para ST/ICMS real da compra)
        cur.execute(
            "SELECT FIRST 1 i.SAC_RECI_CFOP, i.SAC_RECI_PER_ICMS, i.SAC_RECI_VLR_ICMS_ST, "
            "  i.SAC_RECI_VL_ST_RET, i.SAC_RECI_PERC_ST_RET, i.SAC_RECI_NCM, n.SAC_REC_DT_ENTRADA "
            "FROM SAC_RECI i "
            "JOIN SAC_REC n ON n.SAC_REC_LOJA=i.SAC_RECI_LOJA AND n.SAC_REC_FORNEC=i.SAC_RECI_FORNEC "
            "  AND n.SAC_REC_DOC=i.SAC_RECI_DOC "
            "WHERE i.SAC_RECI_COD_PROD=? "
            "ORDER BY n.SAC_REC_DT_ENTRADA DESC",
            (cod,),
        )
        ent = cur.fetchone()
        fiscal = None
        if ent:
            cfop, per_icms, v_st, v_st_ret, p_st_ret, ncm_ent, dt = ent
            st = entrada_e_st(cfop, v_st, v_st_ret, p_st_ret)
            fiscal = {
                "st": st,
                "icms_compra_pct": num(per_icms),
                "cfop_entrada": cfop,
                "ncm_entrada": (ncm_ent or "").strip() or None,
                "dt_entrada": dt.isoformat() if dt else None,
            }

        # estoque (best-effort)
        estoque = None
        for sql in (
            "SELECT SUM(CACHE_EST_QTDE) FROM CACHE_EST WHERE CACHE_EST_PRODUTO=?",
            "SELECT SUM(SAC_LOJA_QTD_DISP) FROM SAC_LOJA WHERE SAC_LOJA_PROD_COD=?",
        ):
            try:
                cur.execute(sql, (cod,))
                v = cur.fetchone()[0]
                if v is not None:
                    estoque = num(v)
                    break
            except Exception:
                pass

        return {
            "encontrado": True,
            "codigo": int(cod),
            "descricao": (d["descricao"] or "").strip(),
            "descricao_resumida": (d["descricao_resumida"] or "").strip() or None,
            "referencia": (d["referencia"] or "").strip() or None,
            "marca": (d["marca"] or "").strip() or None,
            "codigo_barras": fmt_barras(d["_barras"]),
            "ncm": (d["ncm"] or "").strip() or None,
            "cest": d["cest"],
            "unidade": (d["unidade"] or "").strip() or None,
            "grupo": (grupo or "").strip() or None,
            "subgrupo": (subgrupo or "").strip() or None,
            "fornecedor": (fornecedor or "").strip() or None,
            "estoque": estoque,
            "custo": {"ultimo": num(d["_ult_custo"]), "medio": num(d["_custo_medio"])},
            "dimensoes": {
                "peso_unit_kg": num(d["_peso_unit"]),
                "peso_emb_kg": num(d["_peso_emb"]),
                "altura_cm": num(d["_altura"]),
                "largura_cm": num(d["_largura"]),
                "comprimento_cm": num(d["_comprimento"]),
            },
            "impostos_cadastro": {
                "icms_pct": num(d["_icms"]),
                "csosn": d["_csosn"],
                "subtrib_pct": num(d["_subtrib"]),
                "pis_pct": num(d["_pis"]),
                "cofins_pct": num(d["_cofins"]),
                "ipi_pct": num(d["_ipi"]),
                "cst_ipi": (d["_cst_ipi"] or "").strip() or None,
                "cfop": d["_cfop"],
            },
            "fiscal_entrada": fiscal,
            "ativo": (d["_ativo"] or "").strip().upper() == "S",
            "fora_linha": (d["_fora_linha"] or "").strip().upper() == "S",
            "dt_cadastro": d["_dt_cad"].isoformat() if d["_dt_cad"] else None,
            "observacao": (d["observacao"] or "").strip() or None,
        }
    finally:
        con.close()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass  # silencia log padrao

    def do_GET(self):
        # health nao exige token
        if self.path == "/health":
            return self._send(200, {"ok": True})

        if TOKEN and self.headers.get("X-API-Key") != TOKEN:
            return self._send(401, {"error": "token_invalido"})

        if self.path.startswith("/produto/"):
            cod_str = self.path.split("/produto/", 1)[1].split("?")[0].strip()
            if not cod_str.isdigit():
                return self._send(400, {"error": "codigo_invalido"})
            try:
                return self._send(200, consultar_produto(int(cod_str)))
            except Exception as e:
                return self._send(500, {"error": "erro_consulta", "detalhe": str(e)})

        self._send(404, {"error": "rota_nao_encontrada"})


def main():
    if not PASSWORD:
        raise SystemExit("Defina FB_PASSWORD. Ex.: setx FB_PASSWORD suasenha (reabra o terminal)")
    if not TOKEN:
        print("AVISO: AGENT_TOKEN vazio — o agente ficara SEM autenticacao. Defina AGENT_TOKEN.")
    srv = ThreadingHTTPServer(("0.0.0.0", AGENT_PORT), Handler)
    print(f"Agente ERP ouvindo em http://0.0.0.0:{AGENT_PORT}  (Firebird {HOST}:{PORT})")
    print("Rotas: GET /health  |  GET /produto/<codigo> (header X-API-Key)")
    srv.serve_forever()


if __name__ == "__main__":
    main()

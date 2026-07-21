# -*- coding: utf-8 -*-
"""
Conexao com o Firebird da loja (AUTOCOM / MGWare) via TCP, porta 3050.
Servidor: 192.168.0.4  ->  G:\\MGWare\\db\\autocom.fdb  (base de PRODUCAO ~20 GB)

Regras:
- Somente LEITURA (SELECT). Nunca escreve na base de producao.
- Conexao TCP (nao abre o arquivo local), nao trava a base.

Credenciais: defina por variavel de ambiente (recomendado) ou passe na linha.
    setx FB_USER SYSDBA
    setx FB_PASSWORD suasenha
"""
import os

HOST = os.environ.get("FB_HOST", "192.168.0.4")
PORT = int(os.environ.get("FB_PORT", "3050"))
DBPATH = os.environ.get("FB_DBPATH", r"G:\MGWare\db\autocom.fdb")
FBCLIENT = os.environ.get(
    "FB_CLIENT", r"C:\Program Files\Firebird\Firebird_3_0\fbclient.dll"
)

# ISO8859_1 (Latin-1) mapeia os 256 bytes -> nunca quebra na decodificacao.
# (WIN1252 falha em bytes como 0x81 que aparecem na base.)
CHARSET = os.environ.get("FB_CHARSET", "ISO8859_1")


def conectar(user=None, password=None):
    """Retorna uma conexao firebird-driver em modo leitura."""
    from firebird.driver import connect, driver_config

    user = user or os.environ.get("FB_USER", "SYSDBA")
    password = password or os.environ.get("FB_PASSWORD", "")
    if not password:
        raise RuntimeError(
            "Senha do Firebird ausente. Defina FB_PASSWORD (setx FB_PASSWORD ...)."
        )

    # aponta o client library do Firebird 3 instalado na maquina
    driver_config.fb_client_library.value = FBCLIENT

    dsn = f"{HOST}/{PORT}:{DBPATH}"
    con = connect(dsn, user=user, password=password, charset=CHARSET)
    return con


if __name__ == "__main__":
    # Usa exclusivamente as credenciais das variaveis de ambiente FB_USER/FB_PASSWORD.
    u = os.environ.get("FB_USER", "SYSDBA")
    p = os.environ.get("FB_PASSWORD", "")
    if not p:
        raise SystemExit(
            "Defina a senha:  setx FB_PASSWORD suasenha   (e reabra o terminal)\n"
            "Opcional:        setx FB_USER SYSDBA"
        )
    con = conectar(u, p)
    cur = con.cursor()
    cur.execute(
        "SELECT rdb$get_context('SYSTEM','DB_NAME'), current_timestamp "
        "FROM rdb$database"
    )
    row = cur.fetchone()
    print(f"CONECTOU com user={u!r}")
    print("  DB_NAME :", row[0])
    print("  AGORA   :", row[1])
    con.close()

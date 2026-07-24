import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

// ===========================================================================
// Banco local (SQLite) da fila de revisão de anúncios.
//
// Usa o SQLite EMBUTIDO do Node (node:sqlite, estável a partir do Node 22.13) —
// sem dependência nativa pra compilar. A API DatabaseSync é síncrona.
//
// O arquivo mora em DATA_DIR/revisao.db. Em produção (Docker/easypanel) aponte
// DATA_DIR para um VOLUME montado (ex.: /app/data) — senão a fila some a cada
// redeploy, igual acontece com o .user-token.json.
// ===========================================================================

const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'revisao.db'))

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS revisoes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status        TEXT NOT NULL DEFAULT 'pendente',  -- pendente | publicado | reprovado
    payload       TEXT NOT NULL,                     -- JSON: payload() do wizard + category_attributes + category_path
    titulo        TEXT NOT NULL DEFAULT '',
    preco         REAL,                              -- preço de venda proposto (redundante, p/ listagem)
    custo         REAL,                              -- custo do ERP ou manual (null se não informado)
    cod_erp       TEXT,
    thumb         TEXT,
    media_ml      REAL,                              -- snapshot da média ML no envio (atualizado no detalhe)
    media_ml_n    INTEGER,                           -- nº de anúncios usados na média
    resultado     TEXT,                              -- JSON {item_id, permalink, status, health,…} ao publicar
    motivo        TEXT,                              -- motivo da reprovação
    criado_em     TEXT NOT NULL,                     -- ISO 8601
    atualizado_em TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revisoes_status ON revisoes(status);
`)

# Build + runtime da calculadora-ml (frontend Vite + backend Node)
# node:22 — usamos o SQLite embutido (node:sqlite), estável a partir do 22.13.
FROM node:22-alpine

WORKDIR /app

# Instala dependências (dev incluídas: o vite é necessário pro build)
COPY package*.json ./
RUN npm ci

# Copia o código e gera o build estático (dist/)
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
# Banco da fila de revisão (SQLite). Monte um VOLUME neste caminho no easypanel
# para a fila sobreviver a redeploys.
ENV DATA_DIR=/app/data
EXPOSE 3000

# Sobe o servidor de produção (serve dist/ + rotas /api e /callback)
CMD ["node", "server/server.js"]

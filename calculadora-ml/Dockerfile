# Build + runtime da calculadora-ml (frontend Vite + backend Node)
FROM node:20-alpine

WORKDIR /app

# Instala dependências (dev incluídas: o vite é necessário pro build)
COPY package*.json ./
RUN npm ci

# Copia o código e gera o build estático (dist/)
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Sobe o servidor de produção (serve dist/ + rotas /api e /callback)
CMD ["node", "server/server.js"]

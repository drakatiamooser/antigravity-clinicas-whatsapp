FROM node:20-slim

# Instala ferramentas básicas
RUN apt-get update && apt-get install -y git tzdata && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala dependências
RUN npm install

# Copia o resto do código
COPY . .

# Expõe a porta que o Express vai usar
EXPOSE 7860

# Comando para iniciar
CMD ["node", "server.js"]

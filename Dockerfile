FROM node:22-slim

# Instala ferramentas básicas
RUN apt-get update && apt-get install -y git tzdata && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala dependências
RUN npm install

# Copia o resto do código
COPY . .

# Ajusta permissões do diretório da aplicação para o usuário não-root
RUN chown -R node:node /app

# Expõe a porta que o Express vai usar
EXPOSE 7860

# Execução segura com usuário sem privilégios de root
USER node

# Comando para iniciar
CMD ["node", "server.js"]

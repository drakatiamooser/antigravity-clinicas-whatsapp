FROM node:18-alpine

# Instala dependências necessárias para bibliotecas criptográficas do Baileys
RUN apk add --no-cache git tzdata

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

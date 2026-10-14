FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 4000 4002 5173
CMD ["npm", "run", "dev", "--workspace", "@hookrelay/web"]

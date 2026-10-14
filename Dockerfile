FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci
EXPOSE 4000 4002 5173
CMD ["npm", "run", "dev", "--workspace", "@hookrelay/web"]

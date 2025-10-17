# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=prod || npm i --only=prod
COPY . .
ENV NODE_ENV=production
CMD ["npm", "start"]

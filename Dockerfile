FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . ./
ENV NODE_ENV=production
EXPOSE 4174
CMD ["node", "server.js"]

FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:22-slim
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY server.js kis-api.js ./
COPY public/ ./public/
EXPOSE 3000
CMD ["node", "server.js"]

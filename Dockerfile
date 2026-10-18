# Cart Court server. Runs anywhere that runs a container (Cloud Run, Render, Fly, Railway…).
# Keep exactly one instance running and always on: the Photon iMessage stream is a long-lived connection,
# and the cart lives in one process (saved to MongoDB via MONGODB_URI).
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY data/catalog.json data/household.json data/offers.json ./data/
COPY .env.example ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# node directly (not npm) so SIGTERM reaches the server and it saves before shutting down
CMD ["node", "--use-system-ca", "--import", "tsx", "src/server.ts"]

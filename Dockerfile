# Backend image for Fly.io — Node + Express + better-sqlite3
FROM node:20-slim

# better-sqlite3 compiles native code, so build tools are required
RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend deps first (better layer caching)
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

# Copy the rest of the project (frontend static files + server code)
COPY . .

# SQLite lives on a mounted Fly volume so data survives restarts
ENV DB_PATH=/data/data.db
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/server
CMD ["node", "server.js"]

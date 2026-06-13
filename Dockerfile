# Backend image for Fly.io — runs ONLY the Express server (server.js).
# The Electron app is NOT part of this image; it ships separately and calls
# this backend over HTTPS.
FROM node:20-slim

WORKDIR /app

# Install only what the server needs. electron-builder's postinstall is a
# desktop-app concern, so skip lifecycle scripts here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

# Server code + the static public/ it serves.
COPY server.js ./
COPY public ./public

# Fly routes to the internal port set here; bind 0.0.0.0 via ZEKTHAR_HOSTED.
ENV ZEKTHAR_HOSTED=1
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]

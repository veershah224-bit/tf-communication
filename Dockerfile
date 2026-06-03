# TF Communication — container image for hosting on the internet.
# Works on Fly.io, Render, Railway, or any Docker host.
FROM node:24-slim
WORKDIR /app

# Install production dependencies first (better build caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Store the database + secret keys on a PERSISTENT volume mounted at /data,
# otherwise accounts and messages are lost when the container restarts.
ENV DATA_DIR=/data
ENV TRUST_PROXY=1
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

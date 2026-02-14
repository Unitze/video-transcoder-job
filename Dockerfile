FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --link tsconfig.json ./
COPY --link package.json package-lock.json* ./
RUN npm ci
COPY --link src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runner
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt update -y && \
    apt dist-upgrade -y && \
    apt install -y ffmpeg ca-certificates
WORKDIR /app
COPY --link package.json package-lock.json* ./
# when some packages are needed at runtime in future, uncomment the following line to install them
# RUN npm install --production
COPY --link --from=builder /app/dist/index.js /app/index.js

CMD ["node", "index.js"]

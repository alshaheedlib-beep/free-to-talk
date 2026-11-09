FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data/db \
    UPLOAD_DIR=/data/uploads \
    TRUST_PROXY=1
RUN mkdir -p /data/db /data/uploads && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "server.mjs"]

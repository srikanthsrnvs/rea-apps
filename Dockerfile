FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
ENV UBER_CLI_STATE_DIR=/state
ENTRYPOINT ["/app/bin/docker-entrypoint"]
CMD ["help"]

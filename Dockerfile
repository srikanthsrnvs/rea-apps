FROM node:24-trixie-slim

# Spotify's current amd64 package needs glibc >= 2.39 (Debian 13 has 2.41).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg xvfb xauth dbus-x11 procps && \
    curl -fsSL https://download.spotify.com/debian/pubkey_5384CE82BA52C83A.asc | \
    gpg --dearmor -o /usr/share/keyrings/spotify.gpg && \
    printf '%s\n' 'deb [signed-by=/usr/share/keyrings/spotify.gpg] https://repository.spotify.com stable non-free' \
    > /etc/apt/sources.list.d/spotify.list && \
    apt-get update && apt-get install -y --no-install-recommends spotify-client && \
    rm -rf /var/lib/apt/lists/* && useradd -m -u 10001 spotifycli

WORKDIR /opt/spotify-cli
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY bin/spotify ./bin/spotify
COPY docker/entrypoint.sh /usr/local/bin/spotify-cli-entrypoint
USER spotifycli
ENV XDG_RUNTIME_DIR=/tmp/spotifycli-runtime
ENTRYPOINT ["/usr/local/bin/spotify-cli-entrypoint"]

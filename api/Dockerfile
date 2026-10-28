FROM node:22-bookworm-slim
WORKDIR /app

# ── AI Coach runtimes ─────────────────────────────────────────────────────────
# Claude's Agent SDK and the pinned Codex CLI are npm packages. Cursor Agent bundles
# its own glibc Node, so this image is Debian rather than Alpine — a musl image cannot
# run that binary. Codex's own binary is static and keeps working here. bubblewrap
# enforces the Codex workspace-only permission profile for agent-spawned commands.
# Cursor authenticates with an API key; the CLI reads CURSOR_API_KEY from the job
# environment. Gemini and OpenAI-compatible providers are plain HTTPS calls and need
# no extra binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system coach \
 && useradd --system --gid coach --no-create-home --shell /bin/false coach

# Pinned to the build the official Cursor installer publishes. linux/amd64 maps to x64.
ARG TARGETARCH=amd64
ARG CURSOR_AGENT_VERSION=2026.10.22-27dcf5f
RUN bash -eu -o pipefail -c '\
    case "${TARGETARCH}" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/cursor-agent; \
    curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${arch}/agent-cli-package.tar.gz" \
      | tar -xz --strip-components=1 -C /opt/cursor-agent; \
    ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/agent; \
    ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent; \
    agent --disable-auto-update --version'

# Coach jobs run as this user, which is not root and cannot read /data (chmod 0700 at boot).
# A provider process therefore sees its job temp directory and nothing else — no state files,
# no db.json, no session secret, no provider credential file.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --include=optional \
 && npm cache clean --force \
 && node -e "import('@anthropic-ai/claude-agent-sdk').then(() => console.log('Claude Agent SDK ready'))" \
 && ./node_modules/.bin/codex --version \
 && agent --disable-auto-update --version
COPY server.js ./
COPY coach/ ./coach/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]

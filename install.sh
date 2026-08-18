#!/usr/bin/env sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine and the Compose plugin first."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "The Docker Compose plugin is required."
  exit 1
fi

mkdir -p secrets

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env and secrets/."
  echo "Edit .env, set LOCAL_BIND_ADDRESS to this LXC's LAN IP, and generate LOCAL_ACCESS_TOKEN with: openssl rand -hex 32"
  echo "Copy your SSH key into secrets/ if you want the terminal, then run ./install.sh again."
  exit 0
fi

if ! grep -Eq '^LOCAL_ACCESS_TOKEN=.{32,}$' .env || grep -q "replace-with-a-long-random-token" .env; then
  echo "Add LOCAL_ACCESS_TOKEN to .env with at least 32 characters. Generate one with: openssl rand -hex 32"
  exit 1
fi

if ! grep -Eq '^LOCAL_BIND_ADDRESS=.+$' .env; then
  echo "Add LOCAL_BIND_ADDRESS=<this LXC's LAN IP> to .env. Find it with: hostname -I"
  exit 1
fi

docker compose pull
if grep -q "paste-your-tunnel-token-here" .env; then
  docker compose up -d --build portal manager docker-proxy gateway
  echo "Cloudflare is not configured yet; the local dashboard is running without the tunnel."
else
  docker compose --profile cloudflare up -d --build
fi
docker compose ps

echo "mediactl is running. Open http://<LOCAL_BIND_ADDRESS>:<LOCAL_PORT> on your LAN."

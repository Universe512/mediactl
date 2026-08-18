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
  echo "Edit .env with your domain and Cloudflare tunnel token, copy your SSH key into secrets/, then run ./install.sh again."
  exit 0
fi

if grep -q "paste-your-tunnel-token-here" .env; then
  echo "Replace the placeholder CLOUDFLARE_TUNNEL_TOKEN in .env before starting mediactl."
  exit 1
fi

docker compose pull
docker compose up -d --build
docker compose ps

echo "mediactl is running. Open https://<DASHBOARD_SUBDOMAIN>.<ROOT_DOMAIN> after configuring the Cloudflare route."

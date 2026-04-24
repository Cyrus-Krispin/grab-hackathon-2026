#!/usr/bin/env bash
# Run on the EC2 instance (Amazon Linux 2023) after the repo is at REPO.
set -euo pipefail
REPO="${REPO:-/home/ec2-user/grab-hackathon-2026}"
cd "$REPO/apps/api"
python3.11 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install "fastapi>=0.115.0" "uvicorn[standard]>=0.32.0" "httpx>=0.27.0" "pydantic>=2.0.0" "pydantic-settings>=2.0.0"

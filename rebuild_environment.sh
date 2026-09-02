#!/usr/bin/env bash
# Self-Contained Environment Rebuild Script for Linux/macOS
# Run this script whenever you clone or switch environments!

set -e

echo "=========================================="
echo " CFLS Environment Rebuild Script (Linux/macOS)"
echo "=========================================="

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "[!] Node.js is not installed. Please install Node.js v18+."
    exit 1
fi
echo "[✓] Node.js version: $(node -v)"

# 2. Check pnpm
if ! command -v pnpm &> /dev/null; then
    echo "[!] pnpm not found. Installing pnpm globally..."
    npm install -g pnpm
fi
echo "[✓] pnpm version: $(pnpm -v)"

# 3. Setup .env files from templates
echo ""
echo "[1/3] Setting up environment configuration files..."
setup_env() {
    local template="$1"
    local target="$2"
    if [ -f "$template" ]; then
        if [ ! -f "$target" ]; then
            cp "$template" "$target"
            echo "  + Created $target from $template"
        else
            echo "  - $target already exists (skipped)"
        fi
    fi
}

setup_env ".env.example" ".env"
setup_env "deploy/host/.env.example" "deploy/host/.env"
setup_env "apps/host/.env.example" "apps/host/.env"
setup_env "apps/agent/.env.example" "apps/agent/.env"

# 4. Re-install Node.js dependencies
echo ""
echo "[2/3] Installing workspace dependencies (node_modules)..."
pnpm install

# 5. Build packages
echo ""
echo "[3/3] Building TypeScript package outputs (dist)..."
pnpm build

echo ""
echo "=========================================="
echo " SUCCESS! Workspace environment rebuilt! "
echo "=========================================="

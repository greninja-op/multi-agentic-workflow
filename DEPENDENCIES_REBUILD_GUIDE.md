# Rebuilding Dependencies and Build Artifacts Guide

This repository utilizes [pnpm workspaces](https://pnpm.io/workspaces) for TypeScript packages/apps and Python for brand asset tooling.

Because `node_modules`, Python `.venv` virtual environments, and compiled `dist` directories have been removed to optimize repository size, follow these simple steps to rebuild the environment on any system.

---

## 1. Prerequisites

- **Node.js**: v18.0.0 or higher
- **pnpm**: v9.0.0 or higher (`npm install -g pnpm`)
- **Python**: 3.9+ (only required if running asset utilities in `tools/`)

---

## 2. Re-installing Node Dependencies (`node_modules`)

To re-install all `node_modules` across the entire workspace:

```bash
# From the repository root:
pnpm install
```

Alternatively, if using `npm`:

```bash
npm install
```

---

## 3. Environment Setup (`.env` files)

Copy template configuration files to active `.env` files:

```bash
# Root environment template
cp .env.example .env

# Host deployment environment template
cp deploy/host/.env.example deploy/host/.env

# App environment templates
cp apps/host/.env.example apps/host/.env
cp apps/agent/.env.example apps/agent/.env
```

---

## 4. Re-creating Python Virtual Environment (`.venv`)

If you need to run the Python tool (`tools/prepare-brand-assets.py`):

```bash
# 1. Create the virtual environment
python -m venv .venv

# 2. Activate virtual environment
# On Windows (PowerShell):
.venv\Scripts\Activate.ps1
# On Linux/macOS:
source .venv/bin/activate

# 3. Install requirements
pip install -r tools/requirements.txt.example

# 4. Run your python tools...

# 5. Clean up .venv afterwards to save disk space
deactivate
Remove-Item -Recurse -Force .venv  # Windows
rm -rf .venv                       # Linux/macOS
```

---

## 5. Rebuilding Package Artifacts (`dist`)

To compile all TypeScript packages and outputs (`dist` folders):

```bash
# Build all packages
pnpm build

# Run unit and integration tests
pnpm test
```

---

## 6. Cleaning Workspace Again

If you ever wish to clean `node_modules`, `.venv`, and `dist` outputs again to save space:

```bash
# On Linux/macOS
rm -rf node_modules .venv packages/*/node_modules apps/*/node_modules packages/*/dist

# On Windows PowerShell
Get-ChildItem -Path . -Recurse -Force -Include "node_modules",".venv","dist" | Remove-Item -Recurse -Force
```

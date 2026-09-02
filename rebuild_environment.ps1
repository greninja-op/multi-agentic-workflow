# Self-Contained Environment Rebuild Script for Windows (PowerShell)
# Run this script whenever you clone or switch environments!

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " CFLS Environment Rebuild Script (Windows)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Check Node.js installation
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed or not in PATH. Please install Node.js v18+."
}
Write-Host "[OK] Node.js version: $(node -v)" -ForegroundColor Green

# 2. Check or install pnpm
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host '[!] pnpm not found. Installing pnpm globally...' -ForegroundColor Yellow
    npm install -g pnpm
}
Write-Host "[OK] pnpm version: $(pnpm -v)" -ForegroundColor Green

# 3. Setup .env configuration files from examples if missing
Write-Host "`n[1/3] Setting up environment configuration files..." -ForegroundColor Yellow

$envPairs = @(
    @{ Template = ".env.example"; Target = ".env" },
    @{ Template = "deploy\host\.env.example"; Target = "deploy\host\.env" },
    @{ Template = "apps\host\.env.example"; Target = "apps\host\.env" },
    @{ Template = "apps\agent\.env.example"; Target = "apps\agent\.env" }
)

foreach ($pair in $envPairs) {
    if (Test-Path $pair.Template) {
        if (-not (Test-Path $pair.Target)) {
            Copy-Item $pair.Template $pair.Target
            Write-Host "  + Created $($pair.Target) from $($pair.Template)" -ForegroundColor Green
        } else {
            Write-Host "  - $($pair.Target) already exists (skipped)" -ForegroundColor Gray
        }
    }
}

# 4. Re-install Node.js dependencies
Write-Host "`n[2/3] Installing workspace dependencies (node_modules)..." -ForegroundColor Yellow
pnpm install

# 5. Build packages
Write-Host "`n[3/3] Building TypeScript package outputs (dist)..." -ForegroundColor Yellow
pnpm build

Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host " SUCCESS! Workspace environment rebuilt! " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan

#!/usr/bin/env bash
# =============================================================================
# setup-oracle.sh — Setup otomatis bot WA di Oracle Cloud (Ubuntu 22.04 ARM)
# Jalankan sekali saja setelah VM baru dibuat:
#   bash setup-oracle.sh
# =============================================================================
set -euo pipefail

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Setup WA Claude Bot — Oracle Cloud VM      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# --- 1. Update sistem ---
echo "▶ Update paket sistem..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# --- 2. Install Node.js 24 (via NodeSource) ---
echo "▶ Install Node.js 24..."
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - -qq
sudo apt-get install -y nodejs -qq
node -v && npm -v

# --- 3. Install PM2 (process manager) ---
echo "▶ Install PM2..."
sudo npm install -g pm2 --quiet
pm2 --version

# --- 4. Install PostgreSQL 16 ---
echo "▶ Install PostgreSQL..."
sudo apt-get install -y postgresql postgresql-contrib -qq
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Buat user dan database untuk bot
echo "▶ Setup database PostgreSQL..."
sudo -u postgres psql -c "CREATE USER wabot WITH PASSWORD 'wabot_secret_ganti_ini';" 2>/dev/null || echo "  (User sudah ada, lanjut)"
sudo -u postgres psql -c "CREATE DATABASE wabot OWNER wabot;" 2>/dev/null || echo "  (Database sudah ada, lanjut)"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE wabot TO wabot;"

echo "  ✓ Database: postgresql://wabot:wabot_secret_ganti_ini@localhost:5432/wabot"

# --- 5. Konfigurasi Firewall (UFW) ---
echo "▶ Setup firewall UFW..."
sudo apt-get install -y ufw -qq
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh        # port 22
sudo ufw allow 3000/tcp   # panel admin bot
sudo ufw --force enable
sudo ufw status

# --- 6. Buat folder aplikasi ---
echo "▶ Siapkan folder /opt/wabot..."
sudo mkdir -p /opt/wabot
sudo chown ubuntu:ubuntu /opt/wabot

# --- 7. Install git ---
sudo apt-get install -y git -qq

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Setup sistem selesai!                                   ║"
echo "║                                                          ║"
echo "║  Langkah selanjutnya:                                    ║"
echo "║  1. Upload kode ke /opt/wabot (via git clone atau scp)  ║"
echo "║  2. Buat file .env di /opt/wabot                        ║"
echo "║  3. Jalankan: cd /opt/wabot && npm install              ║"
echo "║  4. Jalankan: pm2 start ecosystem.config.cjs            ║"
echo "║  5. Jalankan: pm2 save && pm2 startup                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "DATABASE_URL yang perlu diisi di .env:"
echo "  postgresql://wabot:wabot_secret_ganti_ini@localhost:5432/wabot"
echo ""
echo "PENTING: Ganti 'wabot_secret_ganti_ini' dengan password yang kuat!"
echo "  sudo -u postgres psql -c \"ALTER USER wabot PASSWORD 'password_baru';\""
echo ""

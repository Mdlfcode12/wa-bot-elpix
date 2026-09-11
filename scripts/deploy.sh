#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Upload dan update kode ke Oracle Cloud VM
# Jalankan dari komputer lokal (Windows: pakai Git Bash atau WSL)
#
# EDIT dua variabel di bawah sebelum menjalankan:
#   VM_IP    = IP publik VM Oracle kamu
#   SSH_KEY  = path ke file private key SSH kamu
# =============================================================================

VM_IP="123.456.789.0"          # ← GANTI dengan IP publik VM kamu
VM_USER="ubuntu"
SSH_KEY="$HOME/.ssh/oracle_key" # ← GANTI dengan path SSH key kamu
REMOTE_DIR="/opt/wabot"

echo "▶ Upload kode ke $VM_USER@$VM_IP:$REMOTE_DIR ..."

# Upload semua file kecuali yang ada di .gitignore
rsync -avz --progress \
  --exclude 'node_modules/' \
  --exclude '.env' \
  --exclude 'auth_info_baileys/' \
  --exclude '*.log' \
  --exclude 'temp_extracted/' \
  --exclude 'files.zip' \
  --exclude 'fix.cjs' \
  --exclude 'chatbotelpix-*.json' \
  --exclude '.git/' \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  ./ "$VM_USER@$VM_IP:$REMOTE_DIR/"

echo ""
echo "▶ Install dependencies dan restart bot di server..."
ssh -i "$SSH_KEY" "$VM_USER@$VM_IP" << 'ENDSSH'
  set -e
  cd /opt/wabot
  npm install --omit=dev
  # Buat folder logs kalau belum ada
  mkdir -p logs
  # Restart bot (kalau sudah jalan) atau start pertama kali
  if pm2 list | grep -q "wabot"; then
    pm2 reload wabot --update-env
    echo "✓ Bot di-reload"
  else
    pm2 start ecosystem.config.cjs
    pm2 save
    echo "✓ Bot pertama kali distart"
  fi
  pm2 status
ENDSSH

echo ""
echo "✅ Deploy selesai! Panel: http://$VM_IP:3000"

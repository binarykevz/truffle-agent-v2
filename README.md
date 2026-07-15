# 🚀 Deployment Guide

## Option A: VPS (Ubuntu/Debian) — Recommended

### 1. Initial Setup
```bash
sudo apt update && sudo apt upgrade -y

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install PM2
bun add -g pm2

# Install system dependencies for file conversion
sudo apt install libreoffice ffmpeg p7zip-full zip -y
```

### 2. Clone and Configure
```bash
git clone <your-repo> ~/truffle-agent
cd ~/truffle-agent
bun install
mkdir -p logs

# Copy and edit .env
cp .env.example .env
nano .env
```

### 3. Start with PM2
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # Follow the sudo command it outputs
```

### 4. Verify
```bash
pm2 status
pm2 logs truffle-agent --lines 30
```

### 5. Useful PM2 Commands
```bash
pm2 logs truffle-agent              # Live logs
pm2 restart truffle-agent           # Restart
pm2 stop truffle-agent              # Stop
pm2 monit                           # Monitor CPU/memory
pm2 reload truffle-agent            # Zero-downtime reload
```

### 6. Log Rotation (Recommended)
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

---

## Option B: Android (Termux)

### 1. Install Ubuntu in Termux
```bash
pkg update && pkg upgrade -y
pkg install proot-distro curl -y
proot-distro install ubuntu
proot-distro login ubuntu
```

### 2. Inside Ubuntu
```bash
apt update && apt upgrade -y
apt install curl unzip libreoffice ffmpeg p7zip-full zip -y

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install PM2
bun add -g pm2

# Clone and setup
cd ~
git clone <your-repo> truffle-agent
cd truffle-agent
bun install
mkdir -p logs

# Start
pm2 start ecosystem.config.cjs
pm2 save
```

### 3. Prevent Android from Killing Termux
1. **Acquire Wakelock**: Swipe down on Termux notification → "Acquire Wakelock"
2. **Disable Battery Optimization**: Settings → Apps → Termux → Battery → Unrestricted
3. **Display Over Other Apps**: Settings → Apps → Termux → Advanced → Allow

### 4. Managing the Bot Later
```bash
proot-distro login ubuntu
pm2 status
pm2 logs truffle-agent
pm2 restart truffle-agent
```

---

## 🔧 Troubleshooting

### Bot keeps restarting
```bash
pm2 logs truffle-agent --err --lines 50
```
Common issues:
- Missing `.env` variables
- Turso database unreachable
- Port conflicts

### File conversion fails
- **PDF/Office**: Ensure LibreOffice is installed (`which soffice`)
- **Audio/Video**: Ensure FFmpeg is installed (`which ffmpeg`)
- **Archives**: Ensure p7zip and zip are installed

### PM2 not found after reboot
Add to `~/.bashrc`:
```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```
Then `source ~/.bashrc`.

---

## 📊 Monitoring

### Health Check
```bash
# Bot status
pm2 status

# Memory usage
pm2 monit

# Recent errors
pm2 logs truffle-agent --err --lines 20
```

### Database Health
```bash
# Check main DB
turso db shell truffle-main "SELECT COUNT(*) FROM allowed_users;"

# Check commands DB
turso db shell truffle-commands "SELECT COUNT(*) FROM commands;"
```

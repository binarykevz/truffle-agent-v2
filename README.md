# 🤖 Truffle Agent — Self-Modifying Agentic Telegram Bot

A production-ready, database-driven agentic Telegram bot built with **Bun.js**, **Turso**, and **DashScope (Qwen)**. Features a self-modifying command system where the owner can add, edit, and delete bot features entirely through Telegram — with AI-powered code validation.

## ✨ Features

### 🧠 Core Agent
- **ReAct agent loop** with persistent memory (Turso)
- **Web crawling** for research
- **Code generation + auto-deploy** (scripts or web servers)
- **OpenClaw webhook integration**
- **Device app launching** (Termux direct launch, VPS inline buttons)
- **AI-driven file conversion** with interactive inline keyboards

### 🏗️ Architecture
- **Two isolated Turso databases** — users/config separated from commands
- **Dynamic command system** — all commands stored in DB, not code
- **AI code fixer** — auto-corrects syntax errors and API misuse before saving
- **Single-owner access control** — hardcoded `OWNER_ID` in `.env`
- **Multi-user management** via Telegram commands

### 📄 File Conversion
- PDF ↔ DOCX, TXT, PNG, JPG
- JPG/JPEG ↔ PNG, WebP, PDF
- HEIC → JPG, PNG
- PPTX/XLSX → PDF
- MP3 ↔ WAV, OGG, M4A
- MP4 → GIF, MP3, AVI
- ZIP ↔ 7Z, TAR.GZ

## 🚀 Quick Start

### 1. Install Bun
```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

### 2. Clone and Install
```bash
git clone <your-repo>
cd truffle-agent
bun install
mkdir -p logs
```

### 3. Install System Dependencies (for file conversion)
```bash
sudo apt update
sudo apt install libreoffice ffmpeg p7zip-full zip -y
```

### 4. Create Two Turso Databases
```bash
turso db create truffle-main
turso db create truffle-commands
turso db tokens create truffle-main
turso db tokens create truffle-commands
```

### 5. Configure `.env`
```env
TURSO_DATABASE_URL=libsql://truffle-main-your-org.turso.io
TURSO_AUTH_TOKEN=your-main-db-token
TURSO_COMMANDS_DATABASE_URL=libsql://truffle-commands-your-org.turso.io
TURSO_COMMANDS_AUTH_TOKEN=your-commands-db-token
OWNER_ID=6076887662
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
```

### 6. Start the Bot
```bash
bun run start
```

### 7. Configure via Telegram
As the owner, send:
```
/setconfig api_key sk-ws-H.XMPEHI...
/setconfig base_url https://ws-xb91hlw222zwqslj.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
/setconfig model qwen-max
```

## 📚 Documentation

- **[README_DEPLOYMENT.md](./README_DEPLOYMENT.md)** — VPS & Termux deployment guide
- **[README_COMMANDS.md](./README_COMMANDS.md)** — Dynamic feature system guide

## 🔒 Security

- Owner ID is hardcoded in `.env` — cannot be changed via Telegram
- Sensitive config values are masked in `/getconfig`
- Owner cannot remove themselves
- Unauthorized users are blocked at the middleware level
- AI code fixer validates all user-submitted code before execution
- Two isolated databases prevent command code from corrupting user data

## 📜 License

MIT

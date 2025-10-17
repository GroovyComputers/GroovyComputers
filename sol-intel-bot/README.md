## sol-intel-bot

A Telegram bot (Node.js + Telegraf) that provides intel for a Solana mint (contract) address: socials (X, website, Telegram), handle history via Wayback, a recycled-handle heuristic, and samples of deleted/unavailable tweets with snapshot links.

### Requirements
- Node.js 18+
- Telegram Bot Token from BotFather
- APIs used: DexScreener (public), optional Helius DAS, optional Birdeye, optional X API bearer for better userId/tweets resolution

### Environment
Copy `.env.example` to `.env` and fill in values:

```
BOT_TOKEN=PASTE_YOUR_BOTFATHER_TOKEN_HERE
HELIUS_KEY=
X_BEARER=
BIRDEYE_KEY=
USE_WEBHOOK=0
WEBHOOK_DOMAIN=
PORT=3000
```

- `HELIUS_KEY` (optional): used to enrich socials via Helius DAS
- `X_BEARER` (optional): used to fetch X userId and to verify deleted/unavailable tweets
- `BIRDEYE_KEY` (optional): used to enrich socials via Birdeye
- `USE_WEBHOOK` (0/1): 0 for long polling (default), 1 to run a webhook server
- `WEBHOOK_DOMAIN`: required only if `USE_WEBHOOK=1` (e.g. `bot.example.com`)
- `PORT`: webhook listen port if using webhook

### Run locally (Node)
```bash
cd sol-intel-bot
npm i
cp .env.example .env
# edit .env and set BOT_TOKEN (and optional keys)
npm start
```
You should see: `Bot launched (long polling)` unless you enabled webhook.

### Run with Docker
```bash
cd sol-intel-bot
cp .env.example .env
# edit .env and set BOT_TOKEN (and optional keys)
docker compose up --build -d
```

### Usage
In any chat with your bot:
```
/intel <CA> [N]
```
- `CA` is a Solana base58 mint (32–44 chars). Quotes allowed. Only the first argument is used.
- `N` is optional number of deleted sample tweets (1–25, default 10).

Example:
```
/intel 7xKXj7sRmW8e4c4NVrh6H3bUEgPzxHwdSyeY5o4uXxJ1 15
```

The bot replies in one message with:
1) X/Twitter handle and link
2) Website
3) Telegram link
4) Handle history from Wayback
5) Recycled handle? heuristic
6) A sample of deleted/unavailable tweets (archived text + snapshot links)
7) Notes about archive limitations

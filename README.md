# Rental Report Server

Pretty, print-friendly rental schedule reports powered by Metabase data.

## How It Works

```
┌──────────────────┐     click link      ┌──────────────────┐
│     Metabase      │ ──────────────────> │  Report Server   │
│  (user sets       │                     │                  │
│   date range,     │     ┌───────────────│  GET /           │ ← renders report UI
│   location, etc.) │     │  fetch data   │  GET /api/data   │ ← proxies Metabase
│                   │     │               │  GET /api/pdf    │ ← Puppeteer → PDF
└──────────────────┘     │               └──────────────────┘
                          │
                          ▼
                ┌──────────────────┐
                │ Metabase Public  │
                │ Card API (JSON)  │
                └──────────────────┘
```

## Setup

### 1. Enable public sharing on your Metabase question

1. Open your rental schedule SQL question in Metabase
2. Click the **Sharing** icon (top right) → **Create a public link**
3. Copy the UUID from the generated URL
   - URL looks like: `https://metabase.rec.us/public/question/cf347ce0-90bb-...`
   - The UUID is: `cf347ce0-90bb-...`

### 2. Configure the server

```bash
cp .env.example .env
```

Edit `.env`:
```
METABASE_URL=https://metabase.rec.us
METABASE_PUBLIC_UUID=cf347ce0-90bb-4669-b73b-56c73edd10cb
PORT=3100
BASE_URL=https://reports.rec.us    # or whatever domain you deploy to
ORG_NAME=Clarksville Parks and Recreation
```

### 3. Install and run

```bash
npm install
npm start
```

Server starts at `http://localhost:3100`.

### 4. Add the link in Metabase

In your Metabase dashboard, add a **Text card** or **Link card** with a URL like:

```
https://reports.rec.us/?start_date=2025-06-01&end_date=2025-06-30
```

Or to pass the dashboard's current filter values dynamically, use Metabase's
**custom destination** on a dashboard card click action (if available), or
build the link with your known date range.

#### URL Parameters

| Param           | Example                        | Notes                           |
|-----------------|--------------------------------|---------------------------------|
| `start_date`    | `2025-06-01`                   | ISO date, maps to `{{start_date}}` |
| `end_date`      | `2025-06-30`                   | ISO date, maps to `{{end_date}}`   |
| `location_name` | `Lapping Park`                 | Comma-separate for multiple     |
| `site_type`     | `court`                        | Optional filter                 |

#### Direct PDF link (no UI, straight to download)

```
https://reports.rec.us/api/pdf?start_date=2025-06-01&end_date=2025-06-30
```

## Deployment Options

### Docker (recommended)

```dockerfile
FROM node:20-slim

# Puppeteer dependencies
RUN apt-get update && apt-get install -y \
    chromium fonts-liberation libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdrm2 libgbm1 libnss3 libxcomposite1 \
    libxdamage1 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

EXPOSE 3100
CMD ["node", "server.js"]
```

### PM2 (on existing server)

```bash
npm install -g pm2
pm2 start server.js --name rental-report
pm2 save
```

## Architecture Notes

- **No CORS issues**: The Express server proxies Metabase API calls server-side
- **No auth needed**: Uses Metabase's public sharing (UUID acts as access token)
- **No build step**: Frontend is vanilla React via CDN (Babel in-browser)
- **PDF via Puppeteer**: Server launches headless Chrome, loads the report page,
  renders to PDF with proper pagination and page numbers
- **Stateless**: All data comes fresh from Metabase on each request

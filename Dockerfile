FROM node:20-slim

# Install Chromium + dependencies for Puppeteer
#
# fonts-noto-color-emoji IS LOAD-BEARING, not decoration. fonts-liberation
# covers Latin text and has ZERO emoji coverage, so with it alone Chromium has
# no glyph for any emoji and renders every one as a tofu box. That is invisible
# in development — a laptop and this sandbox both ship an emoji font — and it
# only shows up in the server-side PDFs, which are the one place the container's
# own fonts are what render.
#
# Every emoji in every Puppeteer PDF was affected, not just one report: the
# rental schedule's Forms / Permit / Paid? / Rec-link columns and its lit and
# instruction note lines, the Director's Report flames, the QBR, and the permit
# posting sheets. Reproduced before fixing, by rendering the exact glyphs under
# a fontconfig holding liberation alone: boxes with the font absent, correct
# glyphs with it present, and the ASCII beside them identical in both.
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3100

CMD ["node", "server.js"]

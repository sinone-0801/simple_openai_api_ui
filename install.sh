# download zip pf latest web-search-mcp
# https://github.com/mrkrsl/web-search-mcp/releases
# → unzip

cd free-serch-mcp-remote-server

# sudo apt update
# sudo apt install libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libcairo2 libpango-1.0-0
# sudo apt install libx11-xcb1 libxcursor1 libxi6 libgtk-3-0 libpangocairo-1.0-0 libcairo-gobject2 libgdk-pixbuf2.0-0
# npx playwright install-deps

npm install
npx playwright-core install
npm run build

node ./dist/index.js --engine google --port 8765 --host 0.0.0.0
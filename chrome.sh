#!/bin/sh
# Headed Chromium on the virtual display with a persistent profile.
# --no-sandbox: this VM runs with no-new-privileges, so Chrome's sandbox can't start.
CHROME=${AB_CHROME_BIN:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1)}
rm -f "$HOME/.agent-browser/profile/SingletonLock"
exec "$CHROME" \
  --no-sandbox \
  --user-data-dir="$HOME/.agent-browser/profile" \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --window-size=1440,900 --window-position=0,0 \
  --no-first-run --no-default-browser-check --password-store=basic \
  --disable-background-timer-throttling --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion \
  --restore-last-session

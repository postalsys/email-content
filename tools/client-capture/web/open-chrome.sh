#!/bin/sh
# Opens a real Google Chrome with a dedicated profile and a local debugging port, with every
# service's login page in its own tab. A person logs in by hand; the capture scripts attach to this
# browser afterwards. Using the installed Chrome rather than an automation build keeps login pages
# from refusing the browser as automated.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$DIR/.state/chrome-web"
mkdir -p "$PROFILE"
URLS=$(node -e "console.log(require('$DIR/web/services.js').map(s => s.login).join(' '))")
open -na "Google Chrome" --args --user-data-dir="$PROFILE" --remote-debugging-port=9333 --remote-allow-origins=http://127.0.0.1:9333 --no-first-run --no-default-browser-check $URLS

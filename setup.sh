#!/bin/bash
# One-time setup for Auto Tab Groups: opens Chrome's extensions page, this folder, and the Anthropic key page.
cd "$(dirname "$0")" || exit 1

open -a "Google Chrome" "chrome://extensions" 2>/dev/null || echo "! Open chrome://extensions in Chrome yourself."
open -R "$PWD/manifest.json"
open -a "Google Chrome" "https://console.anthropic.com/settings/keys" 2>/dev/null

cat <<EOF
In Chrome:
  1. On the Extensions page, turn on "Developer mode" (top right) if it's off.
  2. Drag the auto-tab-groups folder from Finder onto that page
     (or click "Load unpacked" and choose $PWD).
  3. On the Anthropic Console tab, create a key (e.g. "Auto Tab Groups") and copy it.
  4. Paste (⌘V) on the Auto Tab Groups settings page that opened. It saves by itself.

Then press ⌥⇧G (or click the toolbar icon) to sort a window.
EOF

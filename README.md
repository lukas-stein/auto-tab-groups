# Auto Tab Groups

Chrome extension that sorts your tabs into tab groups with Claude, using your own Anthropic API key.

- **Sort a window:** click the toolbar icon or press <kbd>⌥⇧G</kbd>. Every ungrouped tab goes into an existing group, a new group, or stays put if nothing fits.
- **Automatic (off by default):** turn it on in the settings page to have new tabs placed once they've loaded and you've switched away from them, so nothing moves under your cursor. A tab left on its own gets another chance when a related tab shows up.
- **Hands off:**
  - Tabs already in a group are never moved.
  - A tab you drag out of a group is never auto-placed again.
  - Tabs restored at browser start are left alone.
  - The [PR Tabs](https://github.com/lukas-stein/pr-tabs) groups are ignored.
- **Your rules:** plain-English instructions on the settings page, e.g. "Keep everything about my thesis together".

## Cost

Claude Haiku 5.5 by default: about $0.001 to sort 60 tabs, and a fraction of that per new tab. Claude Sonnet 5.5 is selectable and about 20× the price. The settings page shows an estimate of what you've spent.

## Privacy

Sent to Anthropic: each tab's title and its address without the query string or fragment (`?…`, `#…`). Never sent:
- sites on your "Never send" list, including their subdomains
- pinned tabs and incognito tabs
- browser pages such as `chrome://`

Chrome warns at install that the extension can "Read your browsing history". It needs that permission to read tab titles and addresses.

The API key is stored unencrypted in this Chrome profile's extension storage. Use a key just for this extension, ideally in a workspace with a spend limit.

## Setup

```bash
./setup.sh
```

Load the folder on `chrome://extensions` (Developer mode → drag the folder in), create a key in the Anthropic Console, and paste it on the settings page that opens.

To change the shortcut, go to `chrome://extensions/shortcuts`. After editing the code, click the reload icon on the extension's card.

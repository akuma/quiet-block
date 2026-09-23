# QuietBlock

A personal ad blocker for Chrome. Manifest V3, no framework, no build magic.

It exists because mainstream ad blockers open a "What's new" tab after every
update, show promotional panels, and phone home. QuietBlock does none of that:
no telemetry, no analytics, no donation prompts, no store links, and it never
opens a tab on its own. `scripts/check-quiet.mjs` enforces that in CI by
grepping the built bundle.

## Quick start

```bash
bun install
bun run build
```

Then load it in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` directory
4. Open a page with ads and click the QuietBlock toolbar icon

That is the whole installation. There is nothing to sign in to and nothing to
configure before it works: the built-in starter list blocks common ad domains
immediately, and EasyList is downloaded on first run.

## Day-to-day use

**The popup** (click the toolbar icon) shows:

- **Block ads and trackers** — the global switch. Turning it off removes every
  blocking rule, so nothing is intercepted at all.
- **Enabled on this site** — pauses blocking for the current tab until the tab
  closes.
- **Allow permanently** — adds the current site to the whitelist. Whitelisted
  sites are neither blocked nor hidden.
- Today's blocked count for this site and overall.
- **Update lists** — re-downloads the filter lists now.

**The options page** (right-click the icon → Options, or the button in the
popup) manages:

- Filter lists: enable/disable, update, remove, reorder.
- Adding a list by URL. Chrome asks for access to that host the first time.
- Custom rules: a text area, one rule per line, `!` starts a comment.
- Statistics: on/off, the last 7 days, and a clear button.
- How often lists refresh (default: every 24 hours).

### Writing custom rules

The syntax follows Adblock Plus conventions:

```
! comments start with an exclamation mark

! Block everything from an ad domain
||ads.example.com^

! Block only third-party scripts
||tracker.example.com^$script,third-party

! Allow something a list blocked
@@||ads.example.com^$domain=news.example.com

! Hide an element everywhere
##.advertisement

! Hide an element on one site
news.example.com##.leaderboard
```

Rules take effect as soon as you press **Save rules**; no page reload is
needed for requests already in flight on a fresh navigation.

## Permissions, and why each one is needed

| Permission | Why |
| --- | --- |
| `storage` | Settings, whitelist, custom rules and the statistics, in `chrome.storage.local`. |
| `declarativeNetRequest` | The blocking itself. With this permission Chrome grants implicit access to `block` and `allow` rules, so **no host permissions are needed to block anything**. |
| `declarativeNetRequestFeedback` | Reads the rule-match event that the blocked-request counter is built from. Chrome only dispatches it to unpacked extensions, which is the only way QuietBlock is distributed. |
| `alarms` | The periodic filter-list update. |
| `tabs` | The popup needs the active tab's address, and the worker tracks which tab is showing which site so "pause on this site" and the per-site counters work. |
| `host_permissions` (a handful of filter-list hosts) | Fetching the lists themselves. A cross-origin `fetch` from a service worker needs permission for the origin. Adding a list on any other host asks for access to that host at that moment. |

Note that QuietBlock does **not** request `<all_urls>`. Blocking works without
it, and the content script runs on the pages declared in the manifest.

## How it fits together

Four mechanisms, each doing one job:

**1. Network blocking — `declarativeNetRequest` dynamic rules.**
Filter lists are parsed into rule candidates, compacted, and installed as
dynamic rules. Dynamic rules survive browser restarts and extension updates,
so the service worker does not reinstall tens of thousands of rules every time
it wakes up; it only does so when the set actually changed, which it detects by
comparing a signature of the enabled lists against the one it installed.

Compaction is the interesting part. Chrome allows an extension 30,000 dynamic
rules; EasyList and EasyPrivacy together contribute around 110,000. Almost all
of them are the same shape — `||some-ad-domain^` — and a DNR rule that carries
`requestDomains` and no `urlFilter` matches every request to those domains and
their subdomains, which is exactly what `||domain^` means. So plain domain
rules that share the same options are merged into rules carrying a hundred
domains each. The same ~98,000 rules become ~1,300 real rules, and the whole
list is installed instead of a truncated sample.

**2. Element hiding — a `document_start` content script.**
The compiled cosmetic selectors are stored in IndexedDB. The content script
reads them, checks the switches, and injects one `<style>` element. A
stylesheet keeps applying to nodes added later, so ads injected by JavaScript
are hidden too without a mutation observer. Procedural rules (`#?#`) are
recognised but never installed; they need a scriptlet engine that is out of
scope.

**3. Whitelisting — session-scoped allow rules.**
Session rules are the only scope that supports `tabIds`, which is what "pause
this tab until it closes" needs, and Chrome drops them when the browser shuts
down — exactly the lifetime a temporary exemption should have. Two rules per
permanently whitelisted host cover requests *to* the host and requests
*initiated by* it, because DNR ANDs condition properties together.

Whitelist allow rules sit at priority 100, above every blocking rule. A site on
the whitelist always wins.

**4. Statistics — the rule-match debug event.**
Each blocked request is counted against the site that triggered it and stored
under `stats.<YYYY-MM-DD>` in `chrome.storage.local`. The counter is buffered in
memory and flushed on a timer, when the worker is suspended, and whenever the
UI asks, so at most a couple of seconds of counts can be lost. Nothing is ever
uploaded.

See [docs/architecture.md](docs/architecture.md) for the longer version.

## Known limitations

- **Top-level documents are never blocked.** A list rule that would block a
  page itself is dropped. This keeps a bad list from blanking a site, and it
  keeps whitelisting reliable because the page's own request never depends on a
  session rule having been installed in time. Rules that explicitly ask for
  `$document` are therefore ignored.
- **Scriptlets, `$csp`, `$redirect`, `$removeparam` and `$empty` are not
  implemented.** A rule using an unsupported option is dropped rather than
  guessed at, and the options page reports how many rules each list lost that
  way.
- **Procedural cosmetic rules (`#?#`) are skipped.** They need a scriptlet
  engine.
- **The counter needs the extension to be unpacked.** Chrome only dispatches
  `onRuleMatchedDebug` to unpacked extensions. If the event never fires the
  popup shows zero rather than inventing a number.
- **`initiatorDomains` matches the frame that made the request**, not
  necessarily the top-level page, so a `$domain=` rule can behave slightly
  differently from Adblock Plus when an ad sits in a cross-origin iframe.
- **Cosmetic hiding is stylesheet-only.** There is no "pick an element to
  block" tool, and hiding can leave a blank gap where the ad was.
- **Only Chrome.** No Firefox or Safari build.

## Manual test checklist

Run through this after loading a fresh build:

1. **Blocking works.** Open a page with ads. Requests to ad domains are gone
   (check the Network tab) and ad slots are hidden. The popup's counter goes up.
2. **Whitelisting works.** Click **Allow permanently**, reload: the ads come
   back and nothing is hidden. Remove it again and they disappear.
3. **Pausing a site works.** Turn off **Enabled on this site**, reload: ads are
   back. Open the same site in a new tab: it is still blocked there. Close the
   tab, open a new one: blocking is back.
4. **The global switch works.** Turn off **Block ads and trackers**: nothing is
   blocked and nothing is hidden on any site. Turn it back on.
5. **Custom rules work.** In Options, add `##.advertisement` (or a selector that
   matches something on a page you have open), save, reload: it is hidden.
   Add `||example.com^` and confirm requests to that host stop.
6. **Statistics are visible.** With some blocking done, open the popup: today's
   total and this site's count are non-zero. Options → Statistics shows the
   last 7 days. **Clear statistics** zeroes them.
7. **List updates are visible.** Options → **Update** on EasyList: the
   "Updated" column changes. Disconnect the network and update again: a red
   `!` appears on the toolbar icon and the popup says which list failed. No tab
   is opened and nothing pops up.
8. **Nothing is ever opened on its own.** After installing and after updating
   the lists, confirm that no new tab, window or notification appeared.
9. **`bun run check:quiet` passes.** It greps the built bundle for
   `tabs.create`, telemetry endpoints, store links, donation and rating copy,
   and any host that is not a configured filter-list source.

## Out of scope

Deliberately not implemented, and documented so nobody expects them:

- YouTube-specific resistance, anti-adblock reversals, or a full scriptlet
  engine.
- A visual "click an element to block it" picker.
- Accounts, cloud sync, or multiple devices.
- Fancy charts, or exporting statistics anywhere.
- Firefox and Safari. Chrome MV3 only.

## Development

```bash
bun install        # install dev dependencies
bun run build      # produce dist/ (the loadable extension)
bun run typecheck  # tsc --noEmit
bun run test       # unit tests for the filter pipeline (node --test)
bun run icons      # regenerate the PNG icons
bun run check:quiet  # assert the built bundle stays quiet
bun run verify     # all of the above, in order
bun run e2e        # end-to-end test in a real Chrome (needs Chrome installed)
```

`bun run e2e` launches a throwaway browser profile with the built extension
loaded and drives it over the DevTools Protocol: it checks that rules install,
that an ad request is really blocked, that an exception rule is honoured, that
cosmetic hiding really hides, that a whitelisted site is left alone, and that
the global switch removes every rule.

It needs a browser that still accepts `--load-extension`. Recent Google Chrome
builds refuse the flag outright ("--load-extension is not allowed in Google
Chrome"), so the script tries Chrome first and then Edge or Chromium, and skips
any browser that will not load the extension. Point `CHROME_BIN` at a working
binary to override the search.

The filter pipeline (`src/shared/filter/`) is pure TypeScript with no Chrome
APIs, which is why it can be unit tested with plain Node.

## Licence and attribution

QuietBlock's own code is MIT. EasyList and EasyPrivacy are third-party lists
from [easylist.to](https://easylist.to/), used under CC BY-SA 3.0. The starter
list is a small hand-picked set of well-known advertising domains.

# Changelog: what QuietBlock deliberately does not do

This is the list of things commercial ad blockers do that QuietBlock leaves out
on purpose. Each one was a decision, not an omission.

## Removed nuisance behaviour

| Commercial ad blockers | QuietBlock |
| --- | --- |
| Open a "What's new" tab after every update | Never opens a tab. `chrome://extensions` shows the version; that is all. |
| Open a donation page on install and on anniversaries | No donation UI anywhere. `scripts/check-quiet.mjs` fails the build on donation copy. |
| Ask for a rating, or nag after N days of use | No rating prompt, no nag timer, no "enjoying QuietBlock?" dialog. |
| Show a "recommended extensions" or partner-offer panel in the options page | The options page has exactly four sections: general, lists, custom rules, statistics, about. |
| Send anonymous usage statistics, crash reports or "acceptable ads" feedback | No network request except the filter-list downloads you configured. `check:quiet` fails the build on telemetry endpoints. |
| Fetch a remote configuration / kill-switch / experiment flag | No remote config. Behaviour is determined entirely by local state. |
| Show a new-tab page with a search box and a promoted sidebar | No new-tab override at all. |
| Open the store page to ask for a review after an update | No store links. |
| Notify you that your lists are out of date | The toolbar icon shows `!` only when an update actually *failed*, and it clears on the next success. |
| Pre-install extra lists or partner lists you did not ask for | Ships one small built-in starter list plus EasyList. EasyPrivacy is opt-in. |
| Upsell a paid tier with feature-gated rules | Every feature is available. Nothing is gated. |

## Removed from the blocking engine

These are real features that are simply not implemented. They are listed in the
README under *Known limitations* too, so nobody has to discover them by
accident.

- Scriptlets (`##+js(...)`), `$csp`, `$redirect`, `$removeparam`, `$empty`,
  `$webrtc`, `$popup`. A rule using an unsupported option is dropped rather
  than mis-applied, and the options page reports the count.
- Procedural cosmetic rules (`#?#`, `#@?#`), including `:has()` and
  `:-abp-has()`. They need a scriptlet engine.
- Blocking top-level documents. A rule that would blank a whole page is
  dropped; `$document` rules are ignored.
- A visual element-picker for blocking things by hand.
- Anti-adblock circumvention and YouTube-specific handling.

## What replaced them

Where a commercial blocker uses a nuisance to keep users engaged, QuietBlock
uses the least intrusive mechanism that still gets the job done:

- Update failures → a single `!` on the toolbar icon and one line in the popup.
- Out-of-date lists → a timestamp in the popup and the options page.
- Discoverability → the options page, reachable from the popup, and the README.

## Version history

### 1.0.0

First release.

- Manifest V3, TypeScript, Vite. No framework, no runtime dependencies.
- Network blocking via `declarativeNetRequest` dynamic rules, with domain-rule
  compaction so EasyList and EasyPrivacy both install in full inside Chrome's
  30,000-rule budget.
- Cosmetic hiding via a `document_start` content script and one injected
  stylesheet.
- Permanent and per-tab whitelisting, both enforced by session-scoped allow
  rules.
- Local blocked-request statistics, per day and per site, top 10 per day.
- Built-in starter list, EasyList (on by default), EasyPrivacy (opt-in),
  plus user-supplied lists and custom rules.
- Scheduled list updates, default every 24 hours, configurable or manual.
- `scripts/check-quiet.mjs` in `bun run verify`, which fails the build if the
  bundle ever contains tab-opening, telemetry, store, donation or rating code,
  or references a host that is not a configured filter-list source.

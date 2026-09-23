# Architecture

Four mechanisms, each with one job. This document describes how they interact
and the constraints that shaped each decision.

```
                    ┌──────────────────────────────────────────┐
   filter lists ───▶│  background service worker              │
   (EasyList, …)    │                                          │
                    │  parse ──▶ convert ──▶ compact ──▶ DNR   │
                    │                                    rules │
                    │  cosmetic selectors ──▶ IndexedDB        │
                    └───────┬──────────────────────┬───────────┘
                            │ chrome.storage.local │ messages
              ┌─────────────┴───────┐   ┌──────────┴──────────┐
              │  popup              │   │  options page       │
              └─────────────────────┘   └─────────────────────┘
                            ▲
              ┌─────────────┴───────┐
              │  content script     │  reads cosmetic bundle from IndexedDB,
              │  (document_start)   │  injects one <style>
              └─────────────────────┘
```

## 1. Network blocking

`declarativeNetRequest` dynamic rules, in one pool per extension.

**Pipeline.** `parse.ts` turns a filter-list line into a typed value.
`toDnr.ts` converts that into a DNR rule candidate, or drops it with a reason.
`compact.ts` merges candidates. `background/rules.ts` installs them.

**Why dynamic rules and not static rulesets.** Static rulesets are compiled into
the extension package, which means a list update requires shipping a new
extension. QuietBlock is expected to refresh its lists on a schedule, so the
rules have to be installable at runtime. Dynamic rules also survive browser
restarts *and* extension upgrades, so the worker does not need to reinstall
them on every wake-up.

**Why the worker does not reinstall on every wake-up.** `ensureInstalled()`
compares a signature — the enabled lists plus the hash of each list's text —
against the signature of what was last installed. Only a mismatch triggers a
reinstall. The check costs one `chrome.storage.local` read per service-worker
lifetime.

**Rule ids.** Each subscription owns a contiguous block of ids, so recompiling
or disabling a list removes exactly its own ids. The allocator lives in
`chrome.storage.local`.

**Priority ladder.** DNR breaks ties between rules of equal priority by
preferring `allow` over `block`, but the documented ordering between rules of
the *same* action type is explicitly unstable, so nothing relies on it:

| Priority | Meaning |
| --- | --- |
| 1 | ordinary list block |
| 2 | `$important` list block |
| 3 | list exception (`@@`) |
| 4 | user's custom block rule |
| 5 | user's custom exception |
| 100 | whitelist allow |

A whitelisted site always wins, which is what users expect.

**The rule budget, and compaction.** Chrome allows 30,000 dynamic rules per
extension. EasyList and EasyPrivacy together contribute ~110,000 network rules,
almost all of them `||some-ad-domain^`. Installing a truncated sample would
silently drop most of a list.

A DNR rule whose condition carries `requestDomains` and no `urlFilter` matches
every request to those domains and their subdomains — which is exactly what
`||domain^` means. So `compact.ts` groups plain domain rules that share the same
options (action, priority, resource types, `domainType`) and emits one rule per
hundred domains. The result is ~1,300 rules covering ~98,000 source rules, and
both lists install in full.

Compaction only ever happens *within* one subscription, so each list keeps its
own id block. Rules with `initiatorDomains` are never compacted: there the
`urlFilter` matches the request while the domains match the page, so folding the
pattern into `requestDomains` would change which requests the rule applies to.

If the compacted rules still exceed the budget — many lists, or a pathological
list — truncation happens in a defined order: rule tier first (important rules
and exceptions, so a truncated install still avoids breaking pages), then
position in the list. The options page reports how many rules each list lost.

**Why `main_frame` is never blocked.** See the README's known limitations. The
short version: a rule that blanks a whole page is the worst possible failure
mode for an ad blocker, and blocking the document request would make
whitelisting depend on a session rule being installed in time.

## 2. Element hiding

The compiled cosmetic selectors live in `chrome.storage.local` rather than
IndexedDB, for two reasons: `storage.local` has a 10 MB quota that settings,
whitelist and statistics share with them, and — the decisive one — **a content
script reads IndexedDB in the origin of the page it is injected into, not the
extension's origin.** A bundle written by the service worker into the
extension's IndexedDB is simply not there from a content script's point of view.
`chrome.storage.local` is shared by every extension context, so that is where
the bundle goes.

The content script runs at `document_start` on every frame. In order:

1. Read settings and whitelist from `chrome.storage.local`. If blocking is off
   globally or the host is whitelisted, **return without touching the DOM**.
2. Ask the worker for the tab's state. If the tab is temporarily allowed,
   return.
3. Read the cosmetic bundle from IndexedDB and inject one `<style>`.

A stylesheet is enough on its own: CSS keeps applying to nodes added later, so
ads injected by JavaScript are hidden too. No mutation observer, no
per-element work.

Generic selectors (`##.ad`) and site-specific ones (`news.com##.ad`) are stored
separately so the common path is a couple of array reads. Exceptions are
resolved at lookup time: a specific exception beats both specific and generic
hides, a generic exception beats generic hides.

Caps (`COSMETIC_LIMITS`) bound the bundle so a huge list cannot make every page
slow. Selectors are validated before storage — an unterminated string in a
stylesheet would swallow every rule after it — and each selector is emitted as
its own CSS rule so a single bad selector only invalidates itself.

## 3. Whitelisting

Two different lifetimes, two different mechanisms:

**Permanent** — the host is added to `state.whitelist`. `syncWhitelistRules()`
installs two session rules per host: one matching requests *to* the host, one
matching requests *initiated by* it. DNR ANDs condition properties together, so
one rule cannot express "or".

**Temporary** — "pause on this site" is scoped to the tab and stored in
`chrome.storage.session`, which Chrome clears when the browser shuts down. The
matching rule is a session rule with `tabIds`, the only condition that is
tab-scoped, and Chrome drops session rules on shutdown anyway — so the rule
cannot outlive the exemption even if the worker loses track of the tab.

Session rules are used rather than dynamic rules for both, because
`tabIds`/`excludedTabIds` are only valid on session-scoped rules, and because a
temporary exemption that survived a browser restart would be a surprise.

The content script consults the same data before hiding anything, so a
whitelisted site gets neither blocking nor hiding.

## 4. Statistics

`chrome.declarativeNetRequest.onRuleMatchedDebug` fires for every rule that
matches. Chrome only dispatches it to unpacked extensions — which is the only
way QuietBlock is distributed — and it needs the
`declarativeNetRequestFeedback` permission. If the event never fires, the
counter stays at zero; nothing invents a number.

Each event is attributed to the site that made the request, using the worker's
tab-to-host map (refreshed on `tabs.onUpdated` and at start-up) and falling back
to the request's initiator. Requests from the extension itself are ignored.

Counts are buffered in memory and flushed:

- every 2 seconds, or after 200 events, whichever comes first;
- on `chrome.runtime.onSuspend`, before the worker is killed;
- on demand, whenever the popup or options page asks for numbers.

Storage is `chrome.storage.local` under `stats.<YYYY-MM-DD>`, one record per
day, with a per-site map inside it. The options page reads the last 7 days and
shows the top 10 sites per day. **Clear statistics** removes those keys.

## Data flow for a single request

1. Chrome asks DNR whether any rule matches.
2. If a block rule matches, the request never happens. Nothing in QuietBlock
   runs.
3. If a rule matched and the worker is awake, the debug event increments
   today's counter for that site.
4. Separately, when the page loads, the content script injects the stylesheet
   that hides the ad slot the request would have filled.

Steps 2 and 4 are independent: a site can be blocked without being hidden and
vice versa, which is why both mechanisms exist.

## Error handling

- **A list that fails to download** records `lastError` on the subscription.
  The toolbar icon shows a `!`, the popup names the failing list, and the
  options page shows the reason. Nothing is retried in a loop, nothing
  notifies, nothing opens a tab.
- **A rule batch Chrome rejects** throws from `updateDynamicRules`, which is
  atomic — the previous rule set stays in place. The error surfaces in the
  popup/options response rather than failing silently.
- **IndexedDB unavailable** (private mode, quota) makes cosmetic hiding
  no-op rather than throwing; network blocking is unaffected.
- **The worker being killed mid-flush** loses at most a couple of seconds of
  counts.

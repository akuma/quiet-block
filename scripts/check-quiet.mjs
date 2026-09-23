/**
 * The "quiet" guarantee, checked mechanically.
 *
 * QuietBlock's whole reason for existing is that it does not behave like a
 * commercial ad blocker: no tab is ever opened on the user's behalf, no remote
 * configuration is fetched, and nothing asks for money or a review. This script
 * greps the built bundle for those patterns and fails the build if any of them
 * appears, so the guarantee cannot rot away quietly.
 *
 * Run it after `bun run build` (or as part of `bun run verify`).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/** Hosts the extension is allowed to talk to: the filter-list sources. */
const ALLOWED_HOSTS = [
  'easylist.to',
  'easylist-downloads.adblockplus.org',
  'secure.fanboy.co.nz',
  'raw.githubusercontent.com',
];

/** Behavioural patterns: code that must never appear. */
const FORBIDDEN_CODE = [
  ['opens a tab on its own', /\bchrome\.tabs\.create\s*\(|\bbrowser\.tabs\.create\s*\(|\bwindow\.open\s*\(/],
  ['sends telemetry to a third party', /sentry\.io|datadoghq\.com|datadog\s*\(|mixpanel\.com|amplitude\.com|segment\.(?:io|com)|posthog\.com|google-analytics\.com\/collect|\/ingest\/|bugsnag\.com|newrelic\.com|nr-data\.net/],
  ['links to an extension store', /chromewebstore|chrome\.google\.com\/webstore|addons\.mozilla\.org|microsoftedge\.microsoft\.com/],
];

/**
 * Copy patterns: wording that asks the user for money, a review or an upgrade.
 * Deliberately precise - a sentence that says "no donation prompts" is the
 * guarantee being restated, not a violation of it.
 */
const FORBIDDEN_COPY = [
  ['asks for a donation', /buy\s+me\s+a\s+coffee|ko-?fi\.com|patreon\.com|paypal\.me|opencollective|liberapay|\bdonate\s+(?:now|today|here|to\s+(?:support|help))/i],
  ['asks for a rating', /\brate\s+(?:this\s+)?(?:extension|us|it|me)\b|leave\s+a\s+review|give\s+(?:us\s+)?(?:a\s+)?\d\s*stars?\b|review\s+us\b/i],
  ['nags the user to upgrade', /\bupgrade\s+to\s+(?:pro|premium|plus)\b|\bunlock\s+(?:pro|premium)\b|\bfree\s+trial\b/i],
];

/** Reserved-for-documentation hosts, used in placeholder text and examples. */
const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'example.net', 'localhost', '127.0.0.1'];

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>)\]}]+/gi;

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else files.push(full);
  }
  return files;
}

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return rawUrl.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  }
}

async function main() {
  let files;
  try {
    files = await collectFiles(dist);
  } catch {
    console.error(`check:quiet - ${dist} does not exist. Run "bun run build" first.`);
    process.exit(1);
  }

  const targets = files.filter((file) => file.endsWith('.js') || file.endsWith('.html'));
  const problems = [];

  for (const file of targets) {
    const source = await fs.readFile(file, 'utf8');
    const relative = path.relative(root, file);

    const report = (description, evidence) => {
      problems.push(`${relative}: ${description} ("${evidence}")`);
    };

    for (const [description, pattern] of FORBIDDEN_CODE) {
      for (const match of new Set([...source.matchAll(new RegExp(pattern, 'gi'))].map((m) => m[0]))) {
        report(description, match);
      }
    }

    for (const [description, pattern] of FORBIDDEN_COPY) {
      for (const match of new Set([...source.matchAll(new RegExp(pattern, 'gi'))].map((m) => m[0]))) {
        report(description, match);
      }
    }

    // Every URL the built code can reach must be a filter-list source.
    // Matches containing a template placeholder are user-supplied
    // subscription URLs, which the user types and grants access to.
    for (const match of new Set([...source.matchAll(URL_PATTERN)].map((m) => m[0]))) {
      if (match.includes('${')) continue;
      const host = hostOf(match);
      if (PLACEHOLDER_HOSTS.includes(host)) continue;
      if (!ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        problems.push(`${relative}: reaches an unexpected host ("${host}")`);
      }
    }
  }

  if (problems.length > 0) {
    console.error('check:quiet FAILED - the built extension contains:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `check:quiet OK - ${targets.length} built files contain no promotional, telemetry or ` +
      `tab-opening code, and only reference the configured filter-list hosts.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Builds tests/.out/t.html: the real index.html with the Firebase CDN scripts
// swapped for an in-memory mock (tests/firebase-mock.js), so the app runs offline
// with sample society data. Pick the signed-in role with ?role=resident|admin|board|superadmin.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const out = join(here, '.out');
mkdirSync(out, { recursive: true });

const src = readFileSync(join(repo, 'index.html'), 'utf8');
const MARKER = '<!-- jsPDF';
if (!src.includes(MARKER)) throw new Error(`index.html no longer contains the "${MARKER}" marker; update tests/build-harness.mjs`);

let html = src
  .replace(/\s*<script src="https:\/\/www\.gstatic\.com[^"]*"><\/script>/g, '')
  .replace(/\s*<link rel="manifest"[^>]*>/g, '')
  .replace(MARKER, '<script src="firebase-mock.js"></script>\n\n' + MARKER);
if (html.includes('www.gstatic.com/firebasejs')) throw new Error('A Firebase CDN script was not stripped; update tests/build-harness.mjs');

writeFileSync(join(out, 't.html'), html);
copyFileSync(join(here, 'firebase-mock.js'), join(out, 'firebase-mock.js'));

// Local images the page references (logo, icons).
const refs = new Set([...html.matchAll(/src="([^":?#]+\.(?:png|jpe?g|svg|webp))"/g)].map(m => m[1]));
for (const f of refs) if (existsSync(join(repo, f))) copyFileSync(join(repo, f), join(out, f));
console.log(`harness built: ${join(out, 't.html')} (+ ${refs.size} image(s))`);

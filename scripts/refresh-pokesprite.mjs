#!/usr/bin/env node
/**
 * Refresh the checked-in list of pokesprite sprite names.
 *
 * The site decides at build time whether an archetype icon comes from pokesprite or
 * from the Limitless CDN, so it never fires a request that is known to 404. That
 * decision needs to know what pokesprite actually contains — hence this list.
 *
 * Run when new Pokemon appear, or when pokesprite adds Generation 9:
 *   node scripts/refresh-pokesprite.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'publish', 'data', 'pokesprite-names.json');
const API = 'https://data.jsdelivr.com/v1/packages/gh/msikma/pokesprite@master?structure=flat';
const DIR = '/pokemon-gen8/regular/';

const res = await fetch(API);
if (!res.ok) throw new Error(`jsDelivr listing failed: HTTP ${res.status}`);
const { files = [] } = await res.json();

const names = files
    .map((f) => f.name)
    .filter((n) => n.startsWith(DIR) && n.endsWith('.png'))
    .map((n) => n.slice(DIR.length, -'.png'.length))
    .sort();

if (names.length === 0) throw new Error('No sprites found — the repo layout may have changed.');

writeFileSync(OUT, JSON.stringify(names));
console.log(`Wrote ${names.length} sprite names to ${OUT}`);

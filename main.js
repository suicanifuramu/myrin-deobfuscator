'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://myrin.pro/';

const DIRS = {
  source: path.join(__dirname, 'source'),
  webcracked: path.join(__dirname, 'webcracked'),
  deobfuscated: path.join(__dirname, 'deobfuscated'),
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jsdeob/1.0';

function resolveUrl(value, baseUrl) {
  if (value.startsWith('//')) return `https:${value}`;
  return new URL(value, baseUrl).toString();
}

function parseAttributes(tag) {
  const attributes = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(tag))) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function extractAssets(html, baseUrl) {
  const found = new Map();
  const tagRe = /<(script|link)\b[^>]*>/gi;
  let match;
  while ((match = tagRe.exec(html))) {
    const tagName = match[1].toLowerCase();
    const attrs = parseAttributes(match[0]);
    if (tagName === 'script') {
      if (!attrs.src) continue;
      const type = (attrs.type || 'text/javascript').toLowerCase();
      if (type !== 'module' && !/\.m?js($|\?)/i.test(attrs.src)) continue;
      found.set(resolveUrl(attrs.src, baseUrl), 'script');
    } else if (/\bmodulepreload\b/i.test(attrs.rel || '') && attrs.href) {
      found.set(resolveUrl(attrs.href, baseUrl), 'modulepreload');
    }
  }
  return [...found.entries()].map(([url, kind]) => ({ url, kind }));
}

function fileNameFor(url) {
  const name = path.basename(new URL(url).pathname);
  return name && name !== '/' ? name : 'index.js';
}

function number(value) {
  return Number(value).toLocaleString('en-US');
}

function display(filePath) {
  return path.relative(process.cwd(), filePath);
}

async function download(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  return response.text();
}

async function processAsset(asset, index, total) {
  const fileName = fileNameFor(asset.url);
  const baseName = fileName.replace(/\.m?js$/i, '');
  console.log(`\n[${index}/${total}] ${asset.kind}: ${asset.url}`);

  const body = await download(asset.url);
  const sourcePath = path.join(DIRS.source, fileName);
  fs.writeFileSync(sourcePath, body, 'utf8');
  console.log(`  source       ${display(sourcePath)} (${number(body.length)} chars)`);

  const { webcrack } = require('webcrack');
  const webcracked = await webcrack(body);
  const webcrackedPath = path.join(DIRS.webcracked, `${baseName}-webcracked.js`);
  fs.writeFileSync(webcrackedPath, webcracked.code, 'utf8');
  console.log(`  webcracked   ${display(webcrackedPath)} (${number(webcracked.code.length)} chars)`);

  const { deobfuscate } = require('./deobfuscator');
  const { code, stats } = deobfuscate(webcracked.code);
  const deobfuscatedPath = path.join(DIRS.deobfuscated, `${baseName}-deobfuscated.js`);
  fs.writeFileSync(deobfuscatedPath, code, 'utf8');
  console.log(`  deobfuscated ${display(deobfuscatedPath)} (${number(code.length)} chars)`);

  for (const decoder of stats.decoders) {
    console.log(
      `  decoder ${decoder.name}: ${number(decoder.resolved)}/${number(decoder.calls)} calls resolved, ${number(
        decoder.uniqueStrings,
      )} unique strings`,
    );
  }
  if (stats.decoders.length === 0) console.log('  no string decoder detected');
}

async function main() {
  const baseUrl = process.argv[2] || DEFAULT_BASE_URL;
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

  console.log(`Fetching HTML: ${baseUrl}`);
  const html = await download(baseUrl);
  const assets = extractAssets(html, baseUrl);
  if (assets.length === 0) {
    throw new Error('No <script src> or <link rel="modulepreload"> JavaScript asset found');
  }
  console.log(`Found ${assets.length} JavaScript asset(s):`);
  for (const asset of assets) console.log(`  - [${asset.kind}] ${asset.url}`);

  let processed = 0;
  for (const [index, asset] of assets.entries()) {
    try {
      await processAsset(asset, index + 1, assets.length);
      processed += 1;
    } catch (error) {
      console.error(`  failed: ${error.message}`);
    }
  }
  console.log(`\nDone: ${processed}/${assets.length} asset(s) processed.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { extractAssets, resolveUrl, fileNameFor };

'use strict';

const assert = require('assert');
const { deobfuscate } = require('../lib/deobfuscate');
const { analyze } = require('../lib/analyze');
const { parse } = require('../lib/parse');
const { extractAssets } = require('../main');

const strings = [
  'console',
  'log',
  'hello',
  'world',
  'fetch',
  'https://example.com/path?q=1',
  'player',
  'score',
  '関数テスト',
  'aGVsbG8=',
];

const encoded = strings.map((value) => Buffer.from(value, 'utf8').toString('base64'));

const source = [
  `const t=${JSON.stringify(encoded)};`,
  'const n=[];',
  'function o(o){return n[o]??(n[o]=new TextDecoder().decode(Uint8Array.from(atob(t[o]),t=>t.charCodeAt(0))))}',
  'const q=o;',
  'const message=o(2)+" "+q(3);',
  'console[o(1)](o(0));',
  'fetch(o(5));',
  'const score=o(7);',
  'const jp=o(8);',
  'const literal=o("9");',
].join('\n');

const result = deobfuscate(source);

assert.ok(result.code.includes('"hello"'), 'resolves direct call o(2)');
assert.ok(result.code.includes('"world"'), 'resolves alias call q(3)');
assert.ok(result.code.includes('"console"'), 'resolves o(0)');
assert.ok(result.code.includes('console.log'), 'normalizes console["log"]');
assert.ok(result.code.includes('"関数テスト"'), 'decodes utf8');
assert.ok(result.code.includes('"aGVsbG8="'), 'decodes base64-looking string value');
assert.ok(!result.code.includes('function o('), 'removes unused decoder function');
assert.ok(!result.code.includes('const n='), 'removes unused cache array');
assert.ok(!result.code.includes('const t='), 'removes unused string array');
assert.strictEqual(result.stats.resolvedCalls, 8, 'all calls resolved');
assert.strictEqual(result.stats.failedCalls, 0, 'no failed calls');
assert.strictEqual(result.stats.decoders.length, 1, 'one decoder found');

const reparsed = parse(result.code);
assert.ok(reparsed, 'output is parseable');

const keep = deobfuscate(source, { clean: false, normalize: false });
assert.ok(keep.code.includes('function o('), 'keeps decoder with --no-clean');
assert.ok(keep.code.includes('console["log"]'), 'keeps brackets with --no-normalize');

const reassigned = deobfuscate(`${source}\no = () => "hijacked";\n`);
assert.strictEqual(reassigned.stats.resolvedCalls, 0, 'skips decoders that get reassigned');

const report = analyze(source);
assert.strictEqual(report.decoders.length, 1, 'analyze finds decoder');
assert.strictEqual(report.arrays.length, 1, 'analyze finds string array');
assert.strictEqual(report.callStats.resolved, 8, 'analyze resolves calls');
assert.strictEqual(report.decoders[0].uniqueStrings, 8, 'analyze collects unique decoded strings');

const html =
  '<!doctype html><html><head>' +
  '<script type="module" crossorigin src="/game-4e7yTscW.js?v=6359ea471f19"></script>' +
  '<link rel="modulepreload" crossorigin href="/assets/dist-TOQDHwOB.js?v=6359ea471f19">' +
  '<script async src="https://example.com/analytics.js"></script>' +
  '<link rel="stylesheet" href="/style.css">' +
  '</head></html>';
const assets = extractAssets(html, 'https://myrin.pro/');
assert.deepStrictEqual(assets, [
  { url: 'https://myrin.pro/game-4e7yTscW.js?v=6359ea471f19', kind: 'script' },
  { url: 'https://myrin.pro/assets/dist-TOQDHwOB.js?v=6359ea471f19', kind: 'modulepreload' },
  { url: 'https://example.com/analytics.js', kind: 'script' },
]);

process.stdout.write('All tests passed.\n');

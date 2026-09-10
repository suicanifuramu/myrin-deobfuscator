'use strict';

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { parse } = require('./parse');
const { findDecoders, processDecoderCalls, analyzeStringArray } = require('./decoders');

const INDICATORS = [
  ['base64-string-array', /(?:atob|TextDecoder)/],
  ['dynamic-code', /\beval\s*\(|new\s+Function\s*\(/],
  ['debugger-statement', /\bdebugger\b/],
  ['anti-debug', /MutationObserver|devtools|performance\.now|console\.trace/],
  ['integrity-tamper', /integrity|referrerPolicy|modulepreload/],
  ['network', /\bfetch\s*\(|new\s+WebSocket|XMLHttpRequest|navigator\.sendBeacon/],
  ['storage', /localStorage|sessionStorage|indexedDB/],
  ['crypto', /crypto\.subtle|AES|encrypt|decrypt|sha256/i],
  ['obfuscation-cache', /\?\?=|new TextDecoder/],
];

const INTERESTING_RE = /https?:\/\/|\beval\b|debug|cheat|admin|token|secret|password|passwd|hack|dev\b|key\b|auth/i;

function getProgramPath(ast) {
  let programPath = null;
  traverse(ast, {
    Program(path) {
      programPath = path;
      path.stop();
    },
  });
  return programPath;
}

function analyze(source, options = {}) {
  const ast = parse(source);
  const programPath = getProgramPath(ast);

  const decoders = findDecoders(programPath);
  const decoderMap = new Map(decoders.map((decoder) => [decoder.binding, decoder]));
  const callStats = processDecoderCalls(programPath, decoderMap, { apply: false });

  const arrays = [];
  for (const binding of Object.values(programPath.scope.bindings)) {
    const node = binding.path.node;
    if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) continue;
    const info = analyzeStringArray(node.init);
    if (info) {
      arrays.push({
        name: node.id.name,
        entries: info.count,
        encodedRatio: Number(info.encodedRatio.toFixed(3)),
      });
    }
  }

  const imports = [];
  const exports = [];
  for (const node of programPath.node.body) {
    if (t.isImportDeclaration(node)) imports.push(node.source.value);
    if (t.isExportNamedDeclaration(node) && node.source) exports.push(node.source.value);
    if (t.isExportDefaultDeclaration(node)) exports.push('default');
  }

  const indicators = INDICATORS.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);

  const interesting = new Set();
  for (const decoder of decoders) {
    for (const value of decoder.strings) {
      if (value.length < 4 || value.length > 160) continue;
      if (INTERESTING_RE.test(value)) interesting.add(value);
    }
  }

  return {
    file: options.file || null,
    bytes: Buffer.byteLength(source, 'utf8'),
    lines: source.split('\n').length,
    modules: ast.program.sourceType,
    imports,
    exports,
    arrays,
    decoders: decoders.map((decoder) => ({
      name: decoder.name,
      calls: decoder.stats.calls,
      resolved: decoder.stats.resolved,
      failed: decoder.stats.failed,
      skipped: decoder.stats.skipped,
      uniqueStrings: decoder.strings.size,
      strings: [...decoder.strings],
    })),
    callStats,
    indicators,
    interestingStrings: [...interesting].slice(0, 100),
  };
}

module.exports = { analyze };

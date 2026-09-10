'use strict';

const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const { parse } = require('./parse');
const { findDecoders, processDecoderCalls, cleanupDecoderInfra } = require('./decoders');
const { normalize } = require('./normalize');

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

function deobfuscate(source, options = {}) {
  const ast = parse(source);
  const programPath = getProgramPath(ast);

  const decoders = findDecoders(programPath);
  const decoderMap = new Map(decoders.map((decoder) => [decoder.binding, decoder]));
  const callStats = processDecoderCalls(programPath, decoderMap, { apply: true });

  let removedStatements = 0;
  if (options.clean !== false && decoders.length > 0) {
    removedStatements = cleanupDecoderInfra(programPath, decoders);
  }

  let normalized = 0;
  if (options.normalize !== false) {
    normalized = normalize(programPath);
  }

  const code = generate(
    ast,
    { comments: true, compact: false, retainLines: false, jsescOption: { minimal: true } },
    source,
  ).code;

  return {
    code,
    stats: {
      inputBytes: Buffer.byteLength(source, 'utf8'),
      outputBytes: Buffer.byteLength(code, 'utf8'),
      decoders: decoders.map((decoder) => ({
        name: decoder.name,
        calls: decoder.stats.calls,
        resolved: decoder.stats.resolved,
        failed: decoder.stats.failed,
        skipped: decoder.stats.skipped,
        uniqueStrings: decoder.strings.size,
      })),
      resolvedCalls: callStats.resolved,
      failedCalls: callStats.failed,
      skippedCalls: callStats.skipped,
      removedStatements,
      normalized,
    },
  };
}

module.exports = { deobfuscate, getProgramPath };

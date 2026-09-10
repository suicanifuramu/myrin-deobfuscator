#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const HELP = `jsdeob - JavaScript static analyzer and deobfuscator

Usage:
  jsdeob deobfuscate <input.js...> [options]
  jsdeob analyze <input.js...> [options]

Commands:
  deobfuscate   Resolve string-decoder calls and emit cleaned code
  analyze       Report obfuscation structure without writing output

Options:
  -o, --out <path|dir|->   Output file, directory, or "-" for stdout
                           (default: <input>.deobfuscated.js)
      --webcrack           Run webcrack (unminify/bundle) before deobfuscating
      --no-clean           Keep decoder array/function even when unused
      --no-normalize       Skip ["prop"] -> .prop rewriting
      --json               Print machine-readable JSON
  -q, --quiet              Suppress the per-file report
  -h, --help               Show this help
`;

function parseArgs(argv) {
  const options = {
    command: null,
    inputs: [],
    out: null,
    webcrack: false,
    clean: true,
    normalize: true,
    json: false,
    quiet: false,
  };
  const args = argv.slice(2);
  options.command = args.shift() || null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-o' || arg === '--out') options.out = args[++i];
    else if (arg === '--webcrack') options.webcrack = true;
    else if (arg === '--no-clean') options.clean = false;
    else if (arg === '--no-normalize') options.normalize = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '-q' || arg === '--quiet') options.quiet = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else options.inputs.push(arg);
  }
  return options;
}

function number(value) {
  return Number(value).toLocaleString('en-US');
}

function isDirectoryTarget(target) {
  if (target.endsWith('/') || target.endsWith('\\')) return true;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return true;
  return !/\.js$/i.test(target);
}

function resolveOutput(input, out) {
  if (out === '-') return '-';
  if (!out) return `${input.replace(/\.js$/i, '')}.deobfuscated.js`;
  const base = path.basename(input, path.extname(input));
  if (isDirectoryTarget(out)) return path.join(out, `${base}.deobfuscated.js`);
  return out;
}

async function maybeWebcrack(source, enabled, label) {
  if (!enabled) return source;
  let webcrack;
  try {
    ({ webcrack } = require('webcrack'));
  } catch (error) {
    throw new Error('webcrack is not installed; run "pnpm install" inside deobfuscator/');
  }
  process.stderr.write(`[webcrack] ${label}\n`);
  const result = await webcrack(source);
  return result.code;
}

function formatDecoder(decoder) {
  return `${decoder.name}(${number(decoder.calls)} calls: ${number(decoder.resolved)} resolved, ${number(
    decoder.failed,
  )} failed, ${number(decoder.skipped)} skipped, ${number(decoder.uniqueStrings)} unique strings)`;
}

async function runDeobfuscate(options) {
  const results = [];
  for (const input of options.inputs) {
    const source = fs.readFileSync(input, 'utf8');
    const prepared = await maybeWebcrack(source, options.webcrack, input);
    const { deobfuscate } = require('../lib/deobfuscate');
    const { code, stats } = deobfuscate(prepared, { clean: options.clean, normalize: options.normalize });

    const output = resolveOutput(input, options.out);
    if (output === '-') {
      process.stdout.write(code);
    } else {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, code, 'utf8');
    }

    const record = { file: input, output, ...stats };
    results.push(record);

    if (!options.quiet && !options.json) {
      process.stdout.write(`[deobfuscate] ${input}\n`);
      for (const decoder of stats.decoders.length ? stats.decoders : []) {
        process.stdout.write(`  decoder ${formatDecoder(decoder)}\n`);
      }
      if (stats.decoders.length === 0) process.stdout.write('  no string decoder detected\n');
      process.stdout.write(
        `  cleanup: ${number(stats.removedStatements)} statements removed, normalize: ${number(
          stats.normalized,
        )} rewrites\n`,
      );
      process.stdout.write(
        `  size: ${number(stats.inputBytes)} -> ${number(stats.outputBytes)} bytes\n`,
      );
      process.stdout.write(`  output: ${output === '-' ? '(stdout)' : output}\n`);
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  }
}

async function runAnalyze(options) {
  const reports = [];
  for (const input of options.inputs) {
    const source = fs.readFileSync(input, 'utf8');
    const prepared = await maybeWebcrack(source, options.webcrack, input);
    const { analyze } = require('../lib/analyze');
    const report = analyze(prepared, { file: input });
    reports.push({ ...report, strings: undefined, decoders: report.decoders.map(({ strings, ...rest }) => rest) });

    if (!options.quiet && !options.json) {
      process.stdout.write(`[analyze] ${input}\n`);
      process.stdout.write(
        `  size: ${number(report.bytes)} bytes | ${number(report.lines)} line(s) | sourceType: ${report.modules}\n`,
      );
      if (report.arrays.length) {
        for (const array of report.arrays) {
          process.stdout.write(
            `  string array ${array.name}: ${number(array.entries)} entries, encoded ratio ${array.encodedRatio}\n`,
          );
        }
      }
      for (const decoder of report.decoders) {
        process.stdout.write(`  decoder ${formatDecoder(decoder)}\n`);
      }
      if (report.imports.length) process.stdout.write(`  imports: ${report.imports.join(', ')}\n`);
      if (report.indicators.length) process.stdout.write(`  indicators: ${report.indicators.join(', ')}\n`);
      if (report.interestingStrings.length) {
        process.stdout.write('  interesting strings:\n');
        for (const value of report.interestingStrings.slice(0, 15)) {
          process.stdout.write(`    - ${value}\n`);
        }
      }
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.command || options.help) {
    process.stdout.write(HELP);
    process.exit(options.help ? 0 : 1);
  }
  if (options.inputs.length === 0) {
    process.stderr.write('Error: no input files\n');
    process.exit(1);
  }
  if (options.command === 'deobfuscate') {
    await runDeobfuscate(options);
  } else if (options.command === 'analyze') {
    await runAnalyze(options);
  } else {
    process.stderr.write(`Error: unknown command "${options.command}"\n`);
    process.stdout.write(HELP);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
});

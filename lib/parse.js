'use strict';

const parser = require('@babel/parser');

const ATTEMPTS = [
  { sourceType: 'unambiguous' },
  { sourceType: 'module' },
  { sourceType: 'script' },
  {
    sourceType: 'unambiguous',
    plugins: [
      'importAttributes',
      'decorators-legacy',
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'topLevelAwait',
      'dynamicImport',
    ],
  },
];

function parse(source) {
  const failures = [];
  for (const attempt of ATTEMPTS) {
    try {
      const options = { ...attempt, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
      const ast = parser.parse(source, options);
      const errors = (ast.errors || []).filter((error) => error && error.reasonCode !== 'StrictNumericEscape');
      if (errors.length > 0) {
        failures.push(errors[0]);
        continue;
      }
      return ast;
    } catch (error) {
      failures.push(error);
    }
  }
  const failure = failures[0] || new Error('could not parse input');
  failure.message = `Parse failed: ${failure.message}`;
  throw failure;
}

module.exports = { parse };

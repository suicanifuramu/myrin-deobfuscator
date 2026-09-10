'use strict';

const vm = require('vm');

const GLOBALS = [
  'console',
  'TextDecoder',
  'TextEncoder',
  'atob',
  'btoa',
  'decodeURIComponent',
  'decodeURI',
  'encodeURIComponent',
  'encodeURI',
  'unescape',
  'escape',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Symbol',
  'BigInt',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Buffer',
  'URL',
  'URLSearchParams',
  'Reflect',
  'Proxy',
  'Promise',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'queueMicrotask',
  'structuredClone',
];

function createSandbox(extra = {}) {
  const sandbox = { ...extra };
  for (const name of GLOBALS) {
    if (name in sandbox) continue;
    try {
      sandbox[name] = globalThis[name];
    } catch (_) {
      sandbox[name] = undefined;
    }
  }
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

function runInSandbox(code, sandbox, timeout = 10000) {
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { timeout });
  return context;
}

module.exports = { createSandbox, runInSandbox };

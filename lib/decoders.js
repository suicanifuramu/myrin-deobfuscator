'use strict';

const generate = require('@babel/generator').default;
const t = require('@babel/types');
const { createSandbox, runInSandbox } = require('./sandbox');

const DECODE_HINTS = ['atob', 'TextDecoder', 'fromCharCode', 'decodeURIComponent', 'unescape', 'charCodeAt'];
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

const NUMERIC_OPS = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
  '**': (a, b) => a ** b,
  '<<': (a, b) => a << b,
  '>>': (a, b) => a >> b,
  '>>>': (a, b) => a >>> b,
  '&': (a, b) => a & b,
  '|': (a, b) => a | b,
  '^': (a, b) => a ^ b,
};

function analyzeStringArray(node) {
  if (!t.isArrayExpression(node) || node.elements.length < 4) return null;
  const values = [];
  let strings = 0;
  let encoded = 0;
  for (const element of node.elements) {
    if (t.isStringLiteral(element)) {
      values.push(element.value);
      strings += 1;
      if (element.value === '' || BASE64_RE.test(element.value) || BASE64URL_RE.test(element.value)) {
        encoded += 1;
      }
    } else {
      values.push(null);
    }
  }
  if (strings < node.elements.length * 0.8) return null;
  return { values, count: values.length, encodedRatio: encoded / Math.max(1, strings) };
}

function constantIndex(node) {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) {
    if (node.value.trim() === '') return null;
    const value = Number(node.value);
    return Number.isFinite(value) ? value : null;
  }
  if (t.isUnaryExpression(node) && (node.operator === '-' || node.operator === '+')) {
    const value = constantIndex(node.argument);
    if (value === null) return null;
    return node.operator === '-' ? -value : value;
  }
  if (t.isBinaryExpression(node) && NUMERIC_OPS[node.operator]) {
    const left = constantIndex(node.left);
    const right = constantIndex(node.right);
    if (left === null || right === null) return null;
    const value = NUMERIC_OPS[node.operator](left, right);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function decodeIndexExpression(node, decoder, depth = 0) {
  const index = constantIndex(node);
  if (index !== null) {
    const value = decoder.decode(index);
    return value === undefined ? null : t.stringLiteral(value);
  }
  if (t.isConditionalExpression(node) && depth < 5) {
    const consequent = decodeIndexExpression(node.consequent, decoder, depth + 1);
    const alternate = decodeIndexExpression(node.alternate, decoder, depth + 1);
    if (consequent && alternate) return t.conditionalExpression(node.test, consequent, alternate);
  }
  return null;
}

function isFunctionBinding(binding) {
  const node = binding.path.node;
  return (
    t.isFunctionDeclaration(node) ||
    (t.isVariableDeclarator(node) &&
      (t.isFunctionExpression(node.init) || t.isArrowFunctionExpression(node.init)))
  );
}

function isReusableInit(node) {
  return (
    t.isArrayExpression(node) ||
    t.isObjectExpression(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isTemplateLiteral(node) ||
    t.isUnaryExpression(node) ||
    t.isNewExpression(node) ||
    t.isCallExpression(node)
  );
}

function collectProgramRefs(path, programScope) {
  const refs = new Set();
  path.traverse({
    ReferencedIdentifier(refPath) {
      const binding = refPath.scope.getBinding(refPath.node.name);
      if (binding && binding.scope === programScope) refs.add(binding);
    },
  });
  return refs;
}

function collectInfraBindings(rootBinding, programScope) {
  const seen = new Set();
  const queue = [rootBinding];
  while (queue.length > 0) {
    const binding = queue.shift();
    if (!binding || seen.has(binding)) continue;
    seen.add(binding);

    let sourcePath = binding.path;
    if (t.isVariableDeclarator(binding.path.node) && binding.path.node.init) {
      sourcePath = binding.path.get('init');
    } else if (!isFunctionBinding(binding)) {
      continue;
    }
    if (!sourcePath || !sourcePath.node) continue;

    sourcePath.traverse({
      ReferencedIdentifier(refPath) {
        const refBinding = refPath.scope.getBinding(refPath.node.name);
        if (!refBinding || refBinding.scope !== programScope || refBinding === binding) return;
        const node = refBinding.path.node;
        const reusable =
          t.isFunctionDeclaration(node) ||
          (t.isVariableDeclarator(node) && isReusableInit(node.init));
        if (reusable && !seen.has(refBinding)) queue.push(refBinding);
      },
    });
  }
  return seen;
}

function buildSnippet(programPath, bindings) {
  const statements = new Set();
  for (const binding of bindings) {
    const statement = binding.path.getStatementParent();
    if (statement && statement.parentPath === programPath) statements.add(statement.node);
  }
  return programPath.node.body
    .filter((node) => statements.has(node))
    .map((node) => generate(node).code)
    .join('\n');
}

function getFunctionBinding(fnPath, programScope) {
  if (t.isFunctionDeclaration(fnPath.node) && fnPath.node.id) {
    const binding = programScope.getBinding(fnPath.node.id.name);
    if (binding && binding.path === fnPath) return binding;
  }
  const parent = fnPath.parentPath;
  if (parent && t.isVariableDeclarator(parent.node) && t.isIdentifier(parent.node.id)) {
    const binding = programScope.getBinding(parent.node.id.name);
    if (binding && binding.path === parent) return binding;
  }
  return null;
}

function evaluateDecoder(programPath, fnPath, binding) {
  const programScope = programPath.scope;
  const infra = collectInfraBindings(binding, programScope);
  const snippet = buildSnippet(programPath, infra);
  if (!snippet) return null;

  const exportName = binding.identifier.name;
  const sandbox = createSandbox();
  try {
    runInSandbox(
      `${snippet}\n;globalThis.__decode__ = typeof ${exportName} !== "undefined" ? ${exportName} : undefined;`,
      sandbox,
    );
  } catch (_) {
    return null;
  }

  const fn = sandbox.__decode__;
  if (typeof fn !== 'function') return null;

  let works = false;
  for (let index = 0; index < 8; index += 1) {
    try {
      if (typeof fn(index) === 'string') {
        works = true;
        break;
      }
    } catch (_) {
      // keep probing
    }
  }
  if (!works) return null;

  const cache = new Map();
  const strings = new Set();

  return {
    name: exportName,
    binding,
    fnPath,
    dependencies: [...infra].filter((dep) => dep !== binding),
    aliases: new Set(),
    stats: { calls: 0, resolved: 0, failed: 0, skipped: 0 },
    strings,
    decode(index) {
      if (cache.has(index)) return cache.get(index);
      let value;
      try {
        value = fn(index);
      } catch (_) {
        value = undefined;
      }
      if (typeof value !== 'string') value = undefined;
      cache.set(index, value);
      if (value !== undefined) strings.add(value);
      return value;
    },
  };
}

function findDecoders(programPath) {
  const programScope = programPath.scope;
  const decoders = [];
  const knownBindings = new Set();

  const arrayBindings = new Map();
  for (const binding of Object.values(programScope.bindings)) {
    const node = binding.path.node;
    if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) continue;
    const info = analyzeStringArray(node.init);
    if (info) arrayBindings.set(binding, info);
  }
  if (arrayBindings.size === 0) return decoders;

  const functionRefs = new Map();
  programPath.traverse({
    ReferencedIdentifier(path) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !arrayBindings.has(binding)) return;
      const fnPath = path.getFunctionParent();
      if (fnPath) functionRefs.set(fnPath, (functionRefs.get(fnPath) || 0) + 1);
    },
  });

  for (const fnPath of functionRefs.keys()) {
    const ownCode = generate(fnPath.node).code;
    let hasHint = DECODE_HINTS.some((hint) => ownCode.includes(hint));
    if (!hasHint) {
      const refs = collectProgramRefs(fnPath, programScope);
      const helperCode = [...refs]
        .filter((binding) => isFunctionBinding(binding))
        .map((binding) => generate(binding.path.node).code)
        .join('\n');
      hasHint = DECODE_HINTS.some((hint) => helperCode.includes(hint));
    }
    if (!hasHint) continue;

    const binding = getFunctionBinding(fnPath, programScope);
    if (!binding || knownBindings.has(binding)) continue;

    const decoder = evaluateDecoder(programPath, fnPath, binding);
    if (!decoder) continue;
    knownBindings.add(binding);
    decoders.push(decoder);
  }

  return decoders;
}

function resolveDecoderBinding(binding, decoderMap, aliasOut) {
  const seen = new Set();
  let current = binding;
  while (current) {
    if (current.constant === false) return null;
    const hit = decoderMap.get(current);
    if (hit) return hit;
    if (seen.has(current)) return null;
    seen.add(current);
    if (aliasOut) aliasOut.add(current);
    const node = current.path.node;
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.init)) {
      const next = current.path.scope.getBinding(node.init.name);
      if (!next || next === current) return null;
      current = next;
    } else {
      return null;
    }
  }
  return null;
}

function processDecoderCalls(programPath, decoderMap, options = {}) {
  const apply = options.apply !== false;
  const result = { resolved: 0, failed: 0, skipped: 0 };
  if (decoderMap.size === 0) return result;

  programPath.traverse({
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || path.node.arguments.length !== 1) return;
      const binding = path.scope.getBinding(callee.name);
      if (!binding) return;
      const aliases = new Set();
      const decoder = resolveDecoderBinding(binding, decoderMap, aliases);
      if (!decoder) return;
      for (const alias of aliases) decoder.aliases.add(alias);

      decoder.stats.calls += 1;
      const argument = path.node.arguments[0];
      const replacement = decodeIndexExpression(argument, decoder);
      if (!replacement) {
        if (constantIndex(argument) !== null) {
          decoder.stats.failed += 1;
          result.failed += 1;
        } else {
          decoder.stats.skipped += 1;
          result.skipped += 1;
        }
        return;
      }

      if (apply) path.replaceWith(replacement);
      decoder.stats.resolved += 1;
      result.resolved += 1;
    },
  });

  return result;
}

function cleanupDecoderInfra(programPath, decoders) {
  const infra = [];
  for (const decoder of decoders) {
    const group = [decoder.binding, ...decoder.dependencies, ...decoder.aliases];
    for (const binding of group) {
      infra.push({ scope: binding.scope, name: binding.identifier.name, identifier: binding.identifier });
    }
  }

  let removed = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    programPath.scope.crawl();
    let removedThisPass = 0;
    for (const ref of infra) {
      const binding = ref.scope.getBinding(ref.name);
      if (!binding || binding.identifier !== ref.identifier) continue;
      if (binding.referenced) continue;
      const statement = binding.path.getStatementParent();
      if (!statement || statement.removed || !statement.node) continue;
      statement.remove();
      removedThisPass += 1;
    }
    removed += removedThisPass;
    if (removedThisPass === 0) break;
  }
  return removed;
}

module.exports = {
  findDecoders,
  processDecoderCalls,
  cleanupDecoderInfra,
  analyzeStringArray,
  constantIndex,
};

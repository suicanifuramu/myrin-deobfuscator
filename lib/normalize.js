'use strict';

const t = require('@babel/types');

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function normalize(programPath) {
  let changes = 0;

  const memberHandler = (path) => {
    const node = path.node;
    if (!node.computed) return;
    const property = node.property;
    if (t.isStringLiteral(property) && IDENTIFIER_RE.test(property.value)) {
      node.property = t.identifier(property.value);
      node.computed = false;
      changes += 1;
    }
  };

  const keyHandler = (path) => {
    const node = path.node;
    if (t.isStringLiteral(node.key) && IDENTIFIER_RE.test(node.key.value)) {
      node.key = t.identifier(node.key.value);
      node.computed = false;
      changes += 1;
    }
  };

  const valid = (type) => !t.VISITOR_KEYS || Boolean(t.VISITOR_KEYS[type]);
  const visitor = {};
  for (const type of ['MemberExpression', 'OptionalMemberExpression']) {
    if (valid(type)) visitor[type] = memberHandler;
  }
  for (const type of ['ObjectProperty', 'ObjectMethod', 'ClassMethod', 'ClassProperty']) {
    if (valid(type)) visitor[type] = keyHandler;
  }

  programPath.traverse(visitor);
  return changes;
}

module.exports = { normalize };

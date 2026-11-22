import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
const traverse = traverseModule.default ?? traverseModule;
const generate = generateModule.default ?? generateModule;
const id = name => ({ type: 'Identifier', name });
const call = (name, args) => ({ type: 'CallExpression', callee: id(name), arguments: args });
const thunk = body => ({ type: 'ArrowFunctionExpression', async: false, params: [], body });

export function synchronous(source, { removeFunctions = [], core = false, helpers = false, compact = false } = {}) {
  const ast = parse(source, { sourceType: 'module' });
  traverse(ast, {
    ImportDeclaration(path) { path.remove(); },
    ExportNamedDeclaration(path) { if (path.node.declaration) path.replaceWith(path.node.declaration); else path.remove(); },
    ExportDefaultDeclaration(path) { path.remove(); },
    Function(path) {
      if (path.isFunctionDeclaration() && removeFunctions.includes(path.node.id.name)) { path.remove(); return; }
      path.node.async = false;
    },
    AwaitExpression: { exit(path) { path.replaceWith(call('unwrap', [path.node.argument])); } },
    CallExpression: { exit(path) {
      if (helpers) return;
      const { callee, arguments: args } = path.node;
      if (callee.type !== 'MemberExpression' || callee.computed) return;
      if (callee.property.name === 'catch') { path.replaceWith(call('gasCatch', [thunk(callee.object), ...args])); path.skip(); }
      else if (callee.property.name === 'then') { path.replaceWith(call('gasThen', [thunk(callee.object), ...args])); path.skip(); }
      else if (core && callee.object.type === 'Identifier' && callee.object.name === 'Promise' && callee.property.name === 'all') {
        path.replaceWith(call('unwrap', [call('gasAll', args)])); path.skip();
      }
    } },
  });
  return generate(ast, { comments: false, compact }).code;
}

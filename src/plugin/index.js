"use strict";
const generate = require("@babel/generator").default;
const hash = require("string-hash-64");
const traverse = require("@babel/traverse").default;
const { transformSync } = require("@babel/core");
const fs = require("fs");
const convertSourceMap = require("convert-source-map");
/**
 * holds a map of function names as keys and array of argument indexes as values which should be automatically workletized(they have to be functions)(starting from 0)
 */
const functionArgsToWorkletize = new Map([]);

const objectHooks = new Set([]);

const globals = new Set([
  "this",
  "console",
  "performance",
  "_chronoNow",
  "Date",
  "Array",
  "ArrayBuffer",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "Date",
  "HermesInternal",
  "JSON",
  "Math",
  "Number",
  "Object",
  "String",
  "Symbol",
  "undefined",
  "null",
  "UIManager",
  "requestAnimationFrame",
  "_WORKLET",
  "arguments",
  "Boolean",
  "parseInt",
  "parseFloat",
  "Map",
  "WeakMap",
  "WeakRef",
  "Set",
  "_log",
  "_scheduleOnJS",
  "_makeShareableClone",
  "_updateDataSynchronously",
  "eval",
  "_updatePropsPaper",
  "_updatePropsFabric",
  "_removeShadowNodeFromRegistry",
  "RegExp",
  "Error",
  "ErrorUtils",
  "global",
  "_measure",
  "_scrollTo",
  "_dispatchCommand",
  "_setGestureState",
  "_getCurrentTime",
  "_eventTimestamp",
  "_frameTimestamp",
  "isNaN",
  "LayoutAnimationRepository",
  "_notifyAboutProgress",
  "_notifyAboutEnd",
  "Promise",
]);

// leaving way to avoid deep capturing by adding 'stopCapturing' to the blacklist
const blacklistedFunctions = new Set([
  "stopCapturing",
  "toString",
  "map",
  "filter",
  "findIndex",
  "forEach",
  "valueOf",
  "toPrecision",
  "toExponential",
  "constructor",
  "toFixed",
  "toLocaleString",
  "toSource",
  "charAt",
  "charCodeAt",
  "concat",
  "indexOf",
  "lastIndexOf",
  "localeCompare",
  "length",
  "match",
  "replace",
  "search",
  "slice",
  "split",
  "substr",
  "substring",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toUpperCase",
  "every",
  "join",
  "pop",
  "push",
  "reduce",
  "reduceRight",
  "reverse",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "unshift",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "bind",
  "apply",
  "call",
  "__callAsync",
  "includes",
]);

class ClosureGenerator {
  constructor() {
    this.trie = [{}, false];
  }

  mergeAns(oldAns, newAns) {
    const [purePath, node] = oldAns;
    const [purePathUp, nodeUp] = newAns;
    if (purePathUp.length !== 0) {
      return [purePath.concat(purePathUp), nodeUp];
    } else {
      return [purePath, node];
    }
  }

  findPrefixRec(path) {
    const notFound = [[], null];
    if (!path || path.node.type !== "MemberExpression") {
      return notFound;
    }
    const memberExpressionNode = path.node;
    if (memberExpressionNode.property.type !== "Identifier") {
      return notFound;
    }
    if (
      memberExpressionNode.computed ||
      memberExpressionNode.property.name === "value" ||
      blacklistedFunctions.has(memberExpressionNode.property.name)
    ) {
      // a.b[w] -> a.b.w in babel nodes
      // a.v.value
      // sth.map(() => )
      return notFound;
    }
    if (
      path.parent &&
      path.parent.type === "AssignmentExpression" &&
      path.parent.left === path.node
    ) {
      /// captured.newProp = 5;
      return notFound;
    }
    const purePath = [memberExpressionNode.property.name];
    const node = memberExpressionNode;
    const upAns = this.findPrefixRec(path.parentPath);
    return this.mergeAns([purePath, node], upAns);
  }

  findPrefix(base, babelPath) {
    const purePath = [base];
    const node = babelPath.node;
    const upAns = this.findPrefixRec(babelPath.parentPath);
    return this.mergeAns([purePath, node], upAns);
  }

  addPath(base, babelPath) {
    const [purePath, node] = this.findPrefix(base, babelPath);
    let parent = this.trie;
    let index = -1;
    for (const current of purePath) {
      index++;
      if (parent[1]) {
        continue;
      }
      if (!parent[0][current]) {
        parent[0][current] = [{}, false];
      }
      if (index === purePath.length - 1) {
        parent[0][current] = [node, true];
      }
      parent = parent[0][current];
    }
  }

  generateNodeForBase(t, current, parent) {
    const currentNode = parent[0][current];
    if (currentNode[1]) {
      return currentNode[0];
    }
    return t.objectExpression(
      Object.keys(currentNode[0]).map((propertyName) =>
        t.objectProperty(
          t.identifier(propertyName),
          this.generateNodeForBase(t, propertyName, currentNode),
          false,
          true
        )
      )
    );
  }

  generate(t, variables, names) {
    const arrayOfKeys = [...names];
    return t.objectExpression(
      variables.map((variable, index) =>
        t.objectProperty(
          t.identifier(variable.name),
          this.generateNodeForBase(t, arrayOfKeys[index], this.trie),
          false,
          true
        )
      )
    );
  }
}

function isRelease() {
  return ["production", "release"].includes(process.env.BABEL_ENV);
}

function shouldGenerateSourceMap() {
  if (isRelease()) {
    return false;
  }

  if (process.env.REANIMATED_PLUGIN_TESTS === "jest") {
    // We want to detect this, so we can disable source maps (because they break
    // snapshot tests with jest).
    return false;
  }

  return true;
}

function buildWorkletString(t, fun, closureVariables, name, inputMap) {
  function prependClosureVariablesIfNecessary() {
    const closureDeclaration = t.variableDeclaration("const", [
      t.variableDeclarator(
        t.objectPattern(
          closureVariables.map((variable) =>
            t.objectProperty(
              t.identifier(variable.name),
              t.identifier(variable.name),
              false,
              true
            )
          )
        ),
        t.memberExpression(t.thisExpression(), t.identifier("_closure"))
      ),
    ]);

    function prependClosure(path) {
      if (closureVariables.length === 0 || path.parent.type !== "Program") {
        return;
      }

      path.node.body.body.unshift(closureDeclaration);
    }

    function prepandRecursiveDeclaration(path) {
      if (path.parent.type === "Program" && path.node.id && path.scope.parent) {
        const hasRecursiveCalls =
          path.scope.parent.bindings[path.node.id.name]?.references > 0;
        if (hasRecursiveCalls) {
          path.node.body.body.unshift(
            t.variableDeclaration("const", [
              t.variableDeclarator(
                t.identifier(path.node.id.name),
                t.memberExpression(t.thisExpression(), t.identifier("_recur"))
              ),
            ])
          );
        }
      }
    }

    return {
      visitor: {
        "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod":
          (path) => {
            prependClosure(path);
            prepandRecursiveDeclaration(path);
          },
      },
    };
  }

  const expression =
    fun.program.body.find(({ type }) => type === "FunctionDeclaration") ||
    fun.program.body.find(({ type }) => type === "ExpressionStatement")
      .expression;

  const workletFunction = t.functionExpression(
    t.identifier(name),
    expression.params,
    expression.body
  );

  const code = generate(workletFunction).code;

  if (shouldGenerateSourceMap()) {
    // Clear contents array (should be empty anyways)
    inputMap.sourcesContent = [];
    // Include source contents in source map, because Flipper/iframe is not
    // allowed to read files from disk.
    for (const sourceFile of inputMap.sources) {
      inputMap.sourcesContent.push(
        fs.readFileSync(sourceFile).toString("utf-8")
      );
    }
  }

  const includeSourceMap = shouldGenerateSourceMap();

  const transformed = transformSync(code, {
    plugins: [prependClosureVariablesIfNecessary()],
    compact: !includeSourceMap,
    sourceMaps: includeSourceMap,
    inputSourceMap: inputMap,
    ast: false,
    babelrc: false,
    configFile: false,
    comments: false,
  });

  let sourceMap;
  if (includeSourceMap) {
    sourceMap = convertSourceMap.fromObject(transformed.map).toObject();
    // sourcesContent field contains a full source code of the file which contains the worklet
    // and is not needed by the source map interpreter in order to symbolicate a stack trace.
    // Therefore, we remove it to reduce the bandwith and avoid sending it potentially multiple times
    // in files that contain multiple worklets. Along with sourcesContent.
    delete sourceMap.sourcesContent;
  }

  return [transformed.code, JSON.stringify(sourceMap)];
}

function makeWorkletName(t, fun) {
  if (t.isObjectMethod(fun)) {
    return fun.node.key.name;
  }
  if (t.isFunctionDeclaration(fun)) {
    return fun.node.id.name;
  }
  if (t.isFunctionExpression(fun) && t.isIdentifier(fun.node.id)) {
    return fun.node.id.name;
  }
  return "anonymous"; // fallback for ArrowFunctionExpression and unnamed FunctionExpression
}

function makeWorklet(t, fun, state) {
  // Returns a new FunctionExpression which is a workletized version of provided
  // FunctionDeclaration, FunctionExpression, ArrowFunctionExpression or ObjectMethod.

  const functionName = makeWorkletName(t, fun);

  const closure = new Map();
  const closureGenerator = new ClosureGenerator();

  // remove 'worklet'; directive before generating string
  fun.traverse({
    DirectiveLiteral(path) {
      if (path.node.value === "worklet" && path.getFunctionParent() === fun) {
        path.parentPath.remove();
      }
    },
  });

  // We use copy because some of the plugins don't update bindings and
  // some even break them

  const codeObject = generate(fun.node, {
    sourceMaps: true,
    sourceFileName: state.file.opts.filename,
  });

  // We need to add a newline at the end, because there could potentially be a
  // comment after the function that gets included here, and then the closing
  // bracket would become part of the comment thus resulting in an error, since
  // there is a missing closing bracket.
  const code =
    "(" + (t.isObjectMethod(fun) ? "function " : "") + codeObject.code + "\n)";

  const transformed = transformSync(code, {
    filename: state.file.opts.filename,
    presets: ["@babel/preset-typescript"],
    plugins: [
      "@babel/plugin-transform-shorthand-properties",
      "@babel/plugin-transform-arrow-functions",
      "@babel/plugin-proposal-optional-chaining",
      "@babel/plugin-proposal-nullish-coalescing-operator",
      ["@babel/plugin-transform-template-literals", { loose: true }],
    ],
    ast: true,
    babelrc: false,
    configFile: false,
    inputSourceMap: codeObject.map,
  });

  traverse(transformed.ast, {
    ReferencedIdentifier(path) {
      const name = path.node.name;
      if (globals.has(name) || (fun.node.id && fun.node.id.name === name)) {
        return;
      }

      const parentNode = path.parent;

      if (
        parentNode.type === "MemberExpression" &&
        parentNode.property === path.node &&
        !parentNode.computed
      ) {
        return;
      }

      if (
        parentNode.type === "ObjectProperty" &&
        path.parentPath.parent.type === "ObjectExpression" &&
        path.node !== parentNode.value
      ) {
        return;
      }

      let currentScope = path.scope;

      while (currentScope != null) {
        if (currentScope.bindings[name] != null) {
          return;
        }
        currentScope = currentScope.parent;
      }
      closure.set(name, path.node);
      closureGenerator.addPath(name, path);
    },
  });

  const variables = Array.from(closure.values());

  const privateFunctionId = t.identifier("_f");
  const clone = t.cloneNode(fun.node);
  let funExpression;
  if (clone.body.type === "BlockStatement") {
    funExpression = t.functionExpression(null, clone.params, clone.body);
  } else {
    funExpression = clone;
  }

  const [funString, sourceMapString] = buildWorkletString(
    t,
    transformed.ast,
    variables,
    functionName,
    transformed.map
  );
  const workletHash = hash(funString);

  let location = state.file.opts.filename;
  if (state.opts && state.opts.relativeSourceLocation) {
    const path = require("path");
    location = path.relative(state.cwd, location);
  }

  let lineOffset = 1;
  if (closure.size > 0) {
    // When worklet captures some variables, we append closure destructing at
    // the beginning of the function body. This effectively results in line
    // numbers shifting by the number of captured variables (size of the
    // closure) + 2 (for the opening and closing brackets of the destruct
    // statement)
    lineOffset -= closure.size + 2;
  }

  const pathForStringDefinitions = fun.parentPath.isProgram()
    ? fun
    : fun.findParent((path) => path.parentPath.isProgram());

  const initDataId =
    pathForStringDefinitions.parentPath.scope.generateUidIdentifier(
      `worklet_${workletHash}_init_data`
    );

  const initDataObjectExpression = t.objectExpression([
    t.objectProperty(t.identifier("code"), t.stringLiteral(funString)),
    t.objectProperty(t.identifier("location"), t.stringLiteral(location)),
  ]);

  if (sourceMapString) {
    initDataObjectExpression.properties.push(
      t.objectProperty(
        t.identifier("__sourceMap"),
        t.stringLiteral(sourceMapString)
      )
    );
  }

  pathForStringDefinitions.insertBefore(
    t.variableDeclaration("const", [
      t.variableDeclarator(initDataId, initDataObjectExpression),
    ])
  );

  const statements = [
    t.variableDeclaration("const", [
      t.variableDeclarator(privateFunctionId, funExpression),
    ]),
    t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(privateFunctionId, t.identifier("_closure"), false),
        closureGenerator.generate(t, variables, closure.keys())
      )
    ),
    t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(
          privateFunctionId,
          t.identifier("__initData"),
          false
        ),
        initDataId
      )
    ),
    t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(
          privateFunctionId,
          t.identifier("__workletHash"),
          false
        ),
        t.numericLiteral(workletHash)
      )
    ),
  ];

  if (!isRelease()) {
    statements.unshift(
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.identifier("_e"),
          t.arrayExpression([
            t.newExpression(t.identifier("Error"), []),
            t.numericLiteral(lineOffset),
            t.numericLiteral(-20), // the placement of opening bracket after Exception in line that defined '_e' variable
          ])
        ),
      ])
    );
    statements.push(
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.memberExpression(
            privateFunctionId,
            t.identifier("__stackDetails"),
            false
          ),
          t.identifier("_e")
        )
      )
    );
  }

  statements.push(t.returnStatement(privateFunctionId));

  const newFun = t.functionExpression(fun.id, [], t.blockStatement(statements));

  return newFun;
}

function processWorkletFunction(t, fun, state) {
  // Replaces FunctionDeclaration, FunctionExpression or ArrowFunctionExpression
  // with a workletized version of itself.

  if (!t.isFunctionParent(fun)) {
    return;
  }

  const newFun = makeWorklet(t, fun, state);

  const replacement = t.callExpression(newFun, []);

  // we check if function needs to be assigned to variable declaration.
  // This is needed if function definition directly in a scope. Some other ways
  // where function definition can be used is for example with variable declaration:
  // const ggg = function foo() { }
  // ^ in such a case we don't need to define variable for the function
  const needDeclaration =
    t.isScopable(fun.parent) || t.isExportNamedDeclaration(fun.parent);
  fun.replaceWith(
    fun.node.id && needDeclaration
      ? t.variableDeclaration("const", [
          t.variableDeclarator(fun.node.id, replacement),
        ])
      : replacement
  );
}

function processWorkletObjectMethod(t, path, state) {
  // Replaces ObjectMethod with a workletized version of itself.

  if (!t.isFunctionParent(path)) {
    return;
  }

  const newFun = makeWorklet(t, path, state);

  const replacement = t.objectProperty(
    t.identifier(path.node.key.name),
    t.callExpression(newFun, [])
  );

  path.replaceWith(replacement);
}

function processIfWorkletNode(t, fun, state) {
  fun.traverse({
    DirectiveLiteral(path) {
      const value = path.node.value;
      if (value === "worklet" && path.getFunctionParent() === fun) {
        // make sure "worklet" is listed among directives for the fun
        // this is necessary as because of some bug, babel will attempt to
        // process replaced function if it is nested inside another function
        const directives = fun.node.body.directives;
        if (
          directives &&
          directives.length > 0 &&
          directives.some(
            (directive) =>
              t.isDirectiveLiteral(directive.value) &&
              directive.value.value === "worklet"
          )
        ) {
          processWorkletFunction(t, fun, state);
        }
      }
    },
  });
}

function processIfGestureHandlerEventCallbackFunctionNode(t, fun, state) {
  // Auto-workletizes React Native Gesture Handler callback functions.
  // Detects `Gesture.Tap().onEnd(<fun>)` or similar, but skips `something.onEnd(<fun>)`.
  // Supports method chaining as well, e.g. `Gesture.Tap().onStart(<fun1>).onUpdate(<fun2>).onEnd(<fun3>)`.

  // Example #1: `Gesture.Tap().onEnd(<fun>)`
  /*
  CallExpression(
    callee: MemberExpression(
      object: CallExpression(
        callee: MemberExpression(
          object: Identifier('Gesture')
          property: Identifier('Tap')
        )
      )
      property: Identifier('onEnd')
    )
    arguments: [fun]
  )
  */

  // Example #2: `Gesture.Tap().onStart(<fun1>).onUpdate(<fun2>).onEnd(<fun3>)`
  /*
  CallExpression(
    callee: MemberExpression(
      object: CallExpression(
        callee: MemberExpression(
          object: CallExpression(
            callee: MemberExpression(
              object: CallExpression(
                callee: MemberExpression(
                  object: Identifier('Gesture')
                  property: Identifier('Tap')
                )
              )
              property: Identifier('onStart')
            )
            arguments: [fun1]
          )
          property: Identifier('onUpdate')
        )
        arguments: [fun2]
      )
      property: Identifier('onEnd')
    )
    arguments: [fun3]
  )
  */

  if (
    t.isCallExpression(fun.parent) &&
    isGestureObjectEventCallbackMethod(t, fun.parent.callee)
  ) {
    processWorkletFunction(t, fun, state);
  }
}

function isGestureObjectEventCallbackMethod(t, node) {
  // Checks if node matches the pattern `Gesture.Foo()[*].onBar`
  // where `[*]` represents any number of method calls.
  return (
    t.isMemberExpression(node) &&
    t.isIdentifier(node.property) &&
    containsGestureObject(t, node.object)
  );
}

function containsGestureObject(t, node) {
  // Checks if node matches the pattern `Gesture.Foo()[*]`
  // where `[*]` represents any number of chained method calls, like `.something(42)`.

  // direct call
  if (isGestureObject(t, node)) {
    return true;
  }

  // method chaining
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    containsGestureObject(t, node.callee.object)
  ) {
    return true;
  }

  return false;
}

function isGestureObject(t, node) {
  // Checks if node matches `Gesture.Tap()` or similar.
  /*
  node: CallExpression(
    callee: MemberExpression(
      object: Identifier('Gesture')
      property: Identifier('Tap')
    )
  )
  */
  return (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object) &&
    node.callee.object.name === "Gesture" &&
    t.isIdentifier(node.callee.property)
  );
}

function processWorklets(t, path, state) {
  const callee =
    path.node.callee.type === "SequenceExpression"
      ? path.node.callee.expressions[path.node.callee.expressions.length - 1]
      : path.node.callee;

  const name =
    callee.type === "MemberExpression" ? callee.property.name : callee.name;

  if (
    objectHooks.has(name) &&
    path.get("arguments.0").type === "ObjectExpression"
  ) {
    const properties = path.get("arguments.0.properties");
    for (const property of properties) {
      if (t.isObjectMethod(property)) {
        processWorkletObjectMethod(t, property, state);
      } else {
        const value = property.get("value");
        processWorkletFunction(t, value, state);
      }
    }
  } else {
    const indexes = functionArgsToWorkletize.get(name);
    if (Array.isArray(indexes)) {
      indexes.forEach((index) => {
        processWorkletFunction(t, path.get(`arguments.${index}`), state);
      });
    }
  }
}

module.exports = function ({ types: t }) {
  return {
    pre() {
      // Extra globals.
      this.opts?.globals?.forEach((name) => {
        globals.add(name);
      });
      // Function arguments that will be automatically transformed to worklets.
      // The format is [{ name: functionName, args: [argumentIndex1, argumentIndex2, ...]}, ...]
      // For example, [{ name: 'useWorklet', args: [0] }] will transform the first argument of functions called useWorklet
      // to a worklet automatically without needed to add the "worklet" directive.
      this.opts?.functionsToWorkletize?.forEach(({ name, args }) => {
        functionArgsToWorkletize.set(name, args);
      });
    },
    visitor: {
      "CallExpression": {
        exit(path, state) {
          processWorklets(t, path, state);
        },
      },
      "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression": {
        exit(path, state) {
          processIfWorkletNode(t, path, state);
          processIfGestureHandlerEventCallbackFunctionNode(t, path, state);
        },
      },
    },
  };
};

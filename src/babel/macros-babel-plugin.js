"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const shared_internals_1 = require("@embroider/shared-internals");
const state_1 = require("./state");
const get_config_1 = require("./get-config");
const macro_condition_1 = __importStar(require("./macro-condition"));
const each_1 = require("./each");
const error_1 = __importDefault(require("./error"));
const fail_build_1 = __importDefault(require("./fail-build"));
const evaluate_json_1 = require("./evaluate-json");
function main(context) {
    let t = context.types;
    let visitor = {
        Program: {
            enter(path, state) {
                (0, state_1.initState)(t, path, state);
                state.packageCache = shared_internals_1.PackageCache.shared('embroider-stage3', state.opts.appPackageRoot);
            },
            exit(_, state) {
                // @embroider/macros itself has no runtime behaviors and should always be removed
                state.importUtil.removeAllImports('@embroider/macros');
                for (let handler of state.jobs) {
                    handler();
                }
            },
        },
        'IfStatement|ConditionalExpression': {
            enter(path, state) {
                if ((0, macro_condition_1.isMacroConditionPath)(path)) {
                    state.calledIdentifiers.add(path.get('test').get('callee').node);
                    (0, macro_condition_1.default)(path, state);
                }
            },
        },
        ForOfStatement: {
            enter(path, state) {
                if ((0, each_1.isEachPath)(path)) {
                    state.calledIdentifiers.add(path.get('right').get('callee').node);
                    (0, each_1.insertEach)(path, state, context);
                }
            },
        },
        FunctionDeclaration: {
            enter(path, state) {
                let id = path.get('id');
                if (id.isIdentifier() && id.node.name === 'initializeRuntimeMacrosConfig') {
                    let pkg = state.owningPackage();
                    if (pkg && pkg.name === '@embroider/macros') {
                        (0, get_config_1.inlineRuntimeConfig)(path, state, context);
                    }
                }
            },
        },
        CallExpression: {
            enter(path, state) {
                let callee = path.get('callee');
                if (!callee.isIdentifier()) {
                    return;
                }
                // failBuild is implemented for side-effect, not value, so it's not
                // handled by evaluateMacroCall.
                if (callee.referencesImport('@embroider/macros', 'failBuild')) {
                    state.calledIdentifiers.add(callee.node);
                    (0, fail_build_1.default)(path, state);
                    return;
                }
                if (callee.referencesImport('@embroider/macros', 'importSync')) {
                    // we handle importSync in the exit hook
                    return;
                }
                // getOwnConfig/getGlobalConfig/getConfig needs special handling, so
                // even though it also emits values via evaluateMacroCall when they're
                // needed recursively by other macros, it has its own insertion-handling
                // code that we invoke here.
                //
                // The things that are special include:
                //  - automatic collapsing of chained properties, etc
                //  - these macros have runtime implementations sometimes, which changes
                //    how we rewrite them
                let mode = callee.referencesImport('@embroider/macros', 'getOwnConfig')
                    ? 'own'
                    : callee.referencesImport('@embroider/macros', 'getGlobalConfig')
                        ? 'getGlobalConfig'
                        : callee.referencesImport('@embroider/macros', 'getConfig')
                            ? 'package'
                            : false;
                if (mode) {
                    state.calledIdentifiers.add(callee.node);
                    (0, get_config_1.insertConfig)(path, state, mode, context);
                    return;
                }
                // isTesting can have a runtime implementation. At compile time it
                // instead falls through to evaluateMacroCall.
                if (callee.referencesImport('@embroider/macros', 'isTesting') && state.opts.mode === 'run-time') {
                    state.calledIdentifiers.add(callee.node);
                    callee.replaceWith(state.importUtil.import(callee, state.pathToOurAddon('runtime'), 'isTesting'));
                    return;
                }
                let result = new evaluate_json_1.Evaluator({ state }).evaluateMacroCall(path);
                if (result.confident) {
                    state.calledIdentifiers.add(callee.node);
                    path.replaceWith((0, evaluate_json_1.buildLiterals)(result.value, context));
                }
            },
            exit(path, state) {
                let callee = path.get('callee');
                if (!callee.isIdentifier()) {
                    return;
                }
                // importSync doesn't evaluate to a static value, so it's implemented
                // directly here, not in evaluateMacroCall.
                // We intentionally do this on exit here, to allow other transforms to handle importSync before we do
                // For example ember-auto-import needs to do some custom transforms to enable use of dynamic template strings,
                // so its babel plugin needs to see and handle the importSync call first!
                if (callee.referencesImport('@embroider/macros', 'importSync')) {
                    if (state.opts.importSyncImplementation === 'eager') {
                        let specifier = path.node.arguments[0];
                        if ((specifier === null || specifier === void 0 ? void 0 : specifier.type) !== 'StringLiteral') {
                            throw new Error(`importSync eager mode doesn't implement non string literal arguments yet`);
                        }
                        path.replaceWith(state.importUtil.import(path, specifier.value, '*'));
                        state.calledIdentifiers.add(callee.node);
                    }
                    else {
                        if (path.scope.hasBinding('require')) {
                            path.scope.rename('require');
                        }
                        let r = t.identifier('require');
                        state.generatedRequires.add(r);
                        path.replaceWith(t.callExpression(state.importUtil.import(path, state.pathToOurAddon('es-compat'), 'default', 'esc'), [
                            t.callExpression(r, path.node.arguments),
                        ]));
                    }
                    return;
                }
            },
        },
        ReferencedIdentifier(path, state) {
            for (let candidate of [
                'dependencySatisfies',
                'moduleExists',
                'getConfig',
                'getOwnConfig',
                'failBuild',
                // we cannot check importSync, as the babel transform runs on exit, so *after* this check
                // 'importSync',
                'isDevelopingApp',
                'isDevelopingThisPackage',
                'isTesting',
            ]) {
                if (path.referencesImport('@embroider/macros', candidate) && !state.calledIdentifiers.has(path.node)) {
                    throw (0, error_1.default)(path, `You can only use ${candidate} as a function call`);
                }
            }
            if (path.referencesImport('@embroider/macros', 'macroCondition') && !state.calledIdentifiers.has(path.node)) {
                throw (0, error_1.default)(path, `macroCondition can only be used as the predicate of an if statement or ternary expression`);
            }
            if (path.referencesImport('@embroider/macros', 'each') && !state.calledIdentifiers.has(path.node)) {
                throw (0, error_1.default)(path, `the each() macro can only be used within a for ... of statement, like: for (let x of each(thing)){}`);
            }
            if (state.opts.owningPackageRoot) {
                // there is only an owningPackageRoot when we are running inside a
                // classic ember-cli build. In the embroider stage3 build, there is no
                // owning package root because we're compiling *all* packages
                // simultaneously.
                //
                // given that we're inside classic ember-cli, stop here without trying
                // to rewrite bare `require`. It's not needed, because both our
                // `importSync` and any user-written bare `require` can both mean the
                // same thing: runtime AMD `require`.
                return;
            }
            if (state.opts.importSyncImplementation === 'cjs' &&
                path.node.name === 'require' &&
                !state.generatedRequires.has(path.node) &&
                !path.scope.hasBinding('require') &&
                state.owningPackage().isEmberPackage()) {
                // Our importSync macro has been compiled to `require`. But we want to
                // distinguish that from any pre-existing, user-written `require` in an
                // Ember addon, which should retain its *runtime* meaning.
                path.replaceWith(t.memberExpression(t.identifier('window'), path.node));
            }
        },
    };
    if (context.types.OptionalMemberExpression) {
        // our getConfig and getOwnConfig macros are supposed to be able to absorb
        // optional chaining. To make that work we need to see the optional chaining
        // before preset-env compiles them away.
        visitor.OptionalMemberExpression = {
            enter(path, state) {
                if (state.opts.mode === 'compile-time') {
                    let result = new evaluate_json_1.Evaluator({ state }).evaluate(path);
                    if (result.confident) {
                        path.replaceWith((0, evaluate_json_1.buildLiterals)(result.value, context));
                    }
                }
            },
        };
    }
    return { visitor };
}
exports.default = main;
//# sourceMappingURL=macros-babel-plugin.js.map
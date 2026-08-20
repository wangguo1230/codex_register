import assert from "node:assert/strict";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const serverRoot = path.resolve("server");

function productionFiles(root: string) {
    const files: string[] = [];
    const walk = (directory: string) => {
        for (const entry of readdirSync(directory, {withFileTypes: true})) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(file);
        }
    };
    walk(root);
    return files.sort();
}

function resolveRelativeModule(fromFile: string, specifier: string) {
    if (!specifier.startsWith(".")) return null;
    const raw = path.resolve(path.dirname(fromFile), specifier);
    const candidates = [
        raw,
        raw.replace(/\.js$/, ".ts"),
        `${raw}.ts`,
        path.join(raw, "index.ts"),
    ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
}

function moduleSpecifiers(file: string) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [argument] = node.arguments;
            if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return specifiers;
}

test("服务端生产模块相对依赖存在且依赖图无环", () => {
    const files = productionFiles(serverRoot);
    const known = new Set(files);
    const graph = new Map<string, string[]>();
    const missing: string[] = [];
    for (const file of files) {
        const dependencies: string[] = [];
        for (const specifier of moduleSpecifiers(file)) {
            if (!specifier.startsWith(".")) continue;
            const target = resolveRelativeModule(file, specifier);
            if (!target) {
                missing.push(`${path.relative(serverRoot, file)} -> ${specifier}`);
                continue;
            }
            if (known.has(target)) dependencies.push(target);
        }
        graph.set(file, dependencies);
    }
    assert.deepEqual(missing, []);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    const cycles: string[] = [];
    const visit = (file: string) => {
        if (visited.has(file)) return;
        if (visiting.has(file)) {
            const start = stack.indexOf(file);
            cycles.push(stack.slice(start).concat(file).map((item) => path.relative(serverRoot, item)).join(" -> "));
            return;
        }
        visiting.add(file);
        stack.push(file);
        for (const dependency of graph.get(file) || []) visit(dependency);
        stack.pop();
        visiting.delete(file);
        visited.add(file);
    };
    for (const file of files) visit(file);
    assert.deepEqual(cycles, []);
});

test("服务端静态 HTTP 路由没有重复方法和路径", () => {
    const methods = new Set(["get", "post", "put", "patch", "delete"]);
    const routes = new Map<string, string[]>();
    for (const file of productionFiles(serverRoot)) {
        const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const method = node.expression.name.text.toLowerCase();
                const [argument] = node.arguments;
                if (methods.has(method) && argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && argument.text.startsWith("/")) {
                    const key = `${method.toUpperCase()} ${argument.text}`;
                    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
                    const items = routes.get(key) || [];
                    items.push(`${path.relative(serverRoot, file)}:${location.line + 1}`);
                    routes.set(key, items);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    const duplicates = [...routes].filter(([, locations]) => locations.length > 1);
    assert.ok(routes.size > 0, "未发现任何静态 HTTP 路由");
    assert.deepEqual(duplicates, []);
});

test("db 兼容门面完整转发全部星号仓储导出", async () => {
    const dbFile = path.join(serverRoot, "db.ts");
    const source = ts.createSourceFile(dbFile, readFileSync(dbFile, "utf8"), ts.ScriptTarget.Latest, true);
    const starModules: string[] = [];
    for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement) && !statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            starModules.push(statement.moduleSpecifier.text);
        }
    }
    const facade = await import("./db.js");
    const lost: string[] = [];
    for (const specifier of starModules) {
        const repository = await import(specifier);
        for (const [name, value] of Object.entries(repository)) {
            if (!(name in facade) || facade[name] !== value) lost.push(`${specifier}:${name}`);
        }
    }
    assert.deepEqual(lost, []);
});

test("兼容门面保持薄层且仓储实现不重新膨胀", () => {
    const maxLines = new Map([
        ["db.ts", 50],
        ["repositories/recharge-queue-repository.ts", 30],
        ["repositories/mailbox-repository.ts", 30],
        ["repositories/gmail-rebind-mailbox-repository.ts", 30],
        ["xray-proxy.ts", 80],
    ]);
    for (const [relative, limit] of maxLines) {
        const lines = readFileSync(path.join(serverRoot, relative), "utf8").split(/\r?\n/).length;
        assert.ok(lines <= limit, `${relative} 应保持兼容门面职责（${lines} > ${limit} 行）`);
    }

    const oversized = productionFiles(path.join(serverRoot, "repositories"))
        .map((file) => ({
            file: path.relative(serverRoot, file),
            lines: readFileSync(file, "utf8").split(/\r?\n/).length,
        }))
        .filter((item) => item.lines > 300);
    assert.deepEqual(oversized, []);
});

test("充值领域服务与组合根保持职责边界", () => {
    const oversizedDomains = productionFiles(path.join(serverRoot, "domain"))
        .filter((file) => path.basename(file).startsWith("recharge-"))
        .map((file) => ({
            file: path.relative(serverRoot, file),
            lines: readFileSync(file, "utf8").split(/\r?\n/).length,
        }))
        .filter((item) => item.lines > 300);
    assert.deepEqual(oversizedDomains, []);

    const compositionLimits = new Map([
        ["modules/recharge-module.ts", 300],
        ["modules/recharge-rebind-factory.ts", 300],
        ["modules/recharge-operation-factory.ts", 220],
        ["modules/recharge-export-factory.ts", 120],
    ]);
    for (const [relative, limit] of compositionLimits) {
        const lines = readFileSync(path.join(serverRoot, relative), "utf8").split(/\r?\n/).length;
        assert.ok(lines <= limit, `${relative} 职责边界应保持稳定（${lines} > ${limit} 行）`);
    }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const ts = require('../../daemon/node_modules/typescript');

test('TypeScript resolves getIpcEndpoint from shared module without implicit any', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
  
  test.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const testFile = path.join(tempDir, 'temp-ts-test.ts');
  const sharedModulePath = path.join(__dirname, '../../shared/ipc-endpoint.cjs').replace(/\\/g, '/');
  
  // Create a virtual program
  const sourceText = `
import { getIpcEndpoint } from '${sharedModulePath}';
const endpoint = getIpcEndpoint('win32', 'C:\\\\Users\\\\Bob');
`;

  const compilerOptions = {
    noImplicitAny: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs
  };

  fs.writeFileSync(testFile, sourceText);

  const program = ts.createProgram([testFile], compilerOptions);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(testFile);
  
  let getIpcEndpointSymbol = undefined;
  
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sourceFile);
      if (exprText === 'getIpcEndpoint') {
        const signature = checker.getResolvedSignature(node);
        assert.ok(signature, 'Signature should be resolved');
        const returnType = checker.getReturnTypeOfSignature(signature);
        const typeStr = checker.typeToString(returnType);
        assert.equal(typeStr, 'string', 'Return type must be string');
        getIpcEndpointSymbol = checker.getSymbolAtLocation(node.expression);
      }
    }
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  assert.ok(getIpcEndpointSymbol, 'getIpcEndpoint should be found and type-checked');
  
  const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);
  const errors = diagnostics.map(d => typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText);
  assert.ok(!errors.some(e => e.includes('Could not find a declaration file')), 'Should not have TS7016: ' + errors.join(', '));
});

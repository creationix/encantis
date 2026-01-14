#!/usr/bin/env bun
// =============================================================================
// LSP Test Client
// Simple script to test the language server without VS Code
// =============================================================================

import { spawn } from 'child_process';
import { join } from 'path';

const serverPath = join(import.meta.dir, '../dist/server.js');

// Start the LSP server with --stdio flag
const server = spawn('node', [serverPath, '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let messageId = 0;

function sendMessage(method: string, params: any): void {
  const message = {
    jsonrpc: '2.0',
    id: ++messageId,
    method,
    params,
  };
  const content = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
  server.stdin.write(header + content);
  console.log(`→ ${method}`);
}

function sendNotification(method: string, params: any): void {
  const message = {
    jsonrpc: '2.0',
    method,
    params,
  };
  const content = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
  server.stdin.write(header + content);
  console.log(`→ ${method} (notification)`);
}

// Parse LSP messages from stdout
let buffer = '';
server.stdout.on('data', (data: Buffer) => {
  buffer += data.toString();

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const lengthMatch = header.match(/Content-Length: (\d+)/);
    if (!lengthMatch) break;

    const contentLength = parseInt(lengthMatch[1], 10);
    const contentStart = headerEnd + 4;
    const contentEnd = contentStart + contentLength;

    if (buffer.length < contentEnd) break;

    const content = buffer.slice(contentStart, contentEnd);
    buffer = buffer.slice(contentEnd);

    try {
      const message = JSON.parse(content);
      if (message.method === 'textDocument/publishDiagnostics') {
        console.log(`← Diagnostics for ${message.params.uri}:`);
        if (message.params.diagnostics.length === 0) {
          console.log('   ✓ No errors');
        } else {
          for (const diag of message.params.diagnostics) {
            const severity = diag.severity === 1 ? 'ERROR' : diag.severity === 2 ? 'WARN' : 'INFO';
            console.log(`   ${severity} (${diag.range.start.line + 1}:${diag.range.start.character + 1}): ${diag.message}`);
          }
        }
      } else if (message.result !== undefined) {
        console.log(`← Response:`, JSON.stringify(message.result, null, 2).slice(0, 200));
      } else if (message.method) {
        console.log(`← ${message.method}`);
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  }
});

// Test sequence
async function runTests(): Promise<void> {
  console.log('=== LSP Test Client ===\n');

  // 1. Initialize
  sendMessage('initialize', {
    processId: process.pid,
    capabilities: {},
    rootUri: 'file:///Users/tim/Code/encantis',
  });

  await sleep(100);

  // 2. Initialized notification
  sendNotification('initialized', {});

  await sleep(100);

  // 3. Open a document with NO errors
  console.log('\n--- Test 1: Valid code (trig.ents style) ---');
  sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: 'file:///test/valid.ents',
      languageId: 'encantis',
      version: 1,
      text: `
func add(a: i32, b: i32) -> i32 => a + b

export "main"
func main() -> i32
  local x: i32 = 10
  local y: i32 = 20
  return add(x, y)
end
`,
    },
  });

  await sleep(200);

  // 4. Open a document WITH errors
  console.log('\n--- Test 2: Code with errors ---');
  sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: 'file:///test/errors.ents',
      languageId: 'encantis',
      version: 1,
      text: `
func broken() -> i32
  return undefined_var
end
`,
    },
  });

  await sleep(200);

  // 5. Test hover on builtin
  console.log('\n--- Test 3: Hover on sqrt ---');
  sendMessage('textDocument/hover', {
    textDocument: { uri: 'file:///test/hover.ents' },
    position: { line: 1, character: 10 },
  });

  // First open the document for hover
  sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: 'file:///test/hover.ents',
      languageId: 'encantis',
      version: 1,
      text: `
func test(x: f64) -> f64 => sqrt(x)
`,
    },
  });

  await sleep(200);

  // Re-send hover after document is open
  sendMessage('textDocument/hover', {
    textDocument: { uri: 'file:///test/hover.ents' },
    position: { line: 1, character: 29 }, // position of 'sqrt'
  });

  await sleep(200);

  // 6. Test document change
  console.log('\n--- Test 4: Fix the error ---');
  sendNotification('textDocument/didChange', {
    textDocument: { uri: 'file:///test/errors.ents', version: 2 },
    contentChanges: [{
      text: `
func fixed() -> i32
  local defined_var: i32 = 42
  return defined_var
end
`,
    }],
  });

  await sleep(200);

  // 7. Test hover on identifiers (local, param, function)
  console.log('\n--- Test 5: Hover on identifiers ---');
  sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: 'file:///test/identifiers.ents',
      languageId: 'encantis',
      version: 1,
      text: `
func add(a: i32, b: i32) -> i32 => a + b

func main() -> i32
  local x: i32 = 10
  local y: i32 = 20
  return add(x, y)
end
`,
    },
  });

  await sleep(200);

  // Hover on parameter 'a' (line 2, around char 9)
  console.log('  Hovering on parameter "a":');
  sendMessage('textDocument/hover', {
    textDocument: { uri: 'file:///test/identifiers.ents' },
    position: { line: 1, character: 9 },
  });

  await sleep(100);

  // Hover on local variable 'x' in its usage (line 7, around char 14)
  console.log('  Hovering on local "x":');
  sendMessage('textDocument/hover', {
    textDocument: { uri: 'file:///test/identifiers.ents' },
    position: { line: 6, character: 14 },
  });

  await sleep(100);

  // Hover on function 'add' in its call (line 7, around char 9)
  console.log('  Hovering on function "add":');
  sendMessage('textDocument/hover', {
    textDocument: { uri: 'file:///test/identifiers.ents' },
    position: { line: 6, character: 9 },
  });

  await sleep(200);

  console.log('\n=== Tests Complete ===');
  server.kill();
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runTests().catch(console.error);

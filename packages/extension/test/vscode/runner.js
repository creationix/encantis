// Runs inside VS Code, desktop or web, with the extension as its .vsix
// installs it (see ../run.mjs): what a user does, through VS Code's own
// commands. The workspace holds examples/modular's main.ents and util.ents.
// Plain CommonJS with nothing but `vscode`: the web extension host loads it
// as it loads an extension.

const vscode = require('vscode');

const web = vscode.env.uiKind === vscode.UIKind.Web;
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The value fn gives once it is truthy, or its last value after `ms`
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await sleep(100);
  }
}

async function write(uri, text) {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

function diagnostics(uri, pattern) {
  return until(() => {
    const found = vscode.languages.getDiagnostics(uri);
    return found.some((d) => pattern.test(d.message)) ? found : null;
  });
}

const preview = () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'encantis-wat');

// The preview's text once it is not `before` and passes `ok`
function previewText(before, ok = () => true) {
  return until(() => {
    const text = preview()?.getText();
    return text && text !== before && ok(text) ? text : null;
  });
}

exports.run = async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri;
  const at = (name) => vscode.Uri.joinPath(root, name);
  console.log(`[info] ${web ? 'web' : 'desktop'} VS Code ${vscode.version}, workspace ${root.toString()}`);

  const extension = vscode.extensions.getExtension('creationix.encantis-vscode-ext');
  check('the extension is installed', !!extension, extension?.packageJSON.version);

  // A file with a type error activates the extension and is checked.
  await write(at('bad.ents'), 'export func f() -> i32 => nope\n');
  const bad = await vscode.workspace.openTextDocument(at('bad.ents'));
  await vscode.window.showTextDocument(bad);
  check('it activates on an .ents file', await until(() => extension.isActive, 15000));
  const badDiagnostics = await diagnostics(bad.uri, /nope/);
  check('a type error is reported', !!badDiagnostics, badDiagnostics?.map((d) => d.message).join(' | '));

  // main.ents imports util.ents, which is not open.
  const main = await vscode.workspace.openTextDocument(at('main.ents'));
  await vscode.window.showTextDocument(main);
  const text = main.getText();
  const position = (needle, plus = 0) => main.positionAt(text.indexOf(needle) + plus);

  const hover = await until(async () => {
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', main.uri, position('square_sum', 2));
    const shown = (hovers ?? []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    return /func square_sum/.test(shown) ? shown : null;
  });
  check('hover shows a signature', !!hover, JSON.stringify(hover));
  check('main.ents has no errors', vscode.languages.getDiagnostics(main.uri).length === 0, vscode.languages.getDiagnostics(main.uri).map((d) => d.message).join(' | '));

  const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', main.uri, position('mul(add'));
  const labels = (completion?.items ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  check('completion offers parameters, imports, builtins and keywords', ['a', 'b', 'add', 'mul', 'sqrt', 'while'].every((l) => labels.includes(l)), labels.slice(0, 10).join(', '));

  const signature = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', main.uri, position('add(a, b)', 6), ',');
  check('signature help', signature?.signatures[0]?.label === 'add(a: i32, b: i32) -> i32' && signature.activeParameter === 1, signature?.signatures[0]?.label);

  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', main.uri);
  const names = (symbols ?? []).map((s) => s.name);
  check('the outline', names.includes('square_sum') && names.includes('import "./util"'), names.join(', '));

  // util.ents is not open: found in the workspace
  const inWorkspace = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'add');
  const add = (inWorkspace ?? []).find((s) => s.name === 'add' && s.location.uri.path.endsWith('/util.ents'));
  check('Go to Symbol in Workspace finds a declaration of a file that is not open', !!add, (inWorkspace ?? []).map((s) => `${s.name} ${s.location.uri.path}`).join(', '));

  const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', main.uri, position('"add"'));
  const target = definitions?.[0] && (definitions[0].targetUri ?? definitions[0].uri);
  check('Go to Definition from an import opens the file it imports', !!target && target.path.endsWith('/util.ents'), target?.toString());

  const inlays = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', main.uri, new vscode.Range(0, 0, main.lineCount, 0));
  const inlayLabels = (inlays ?? []).map((h) => (typeof h.label === 'string' ? h.label : h.label.map((part) => part.value).join('')));
  check('inlay hints name the parameters of literal arguments', inlayLabels.includes('a:') && inlayLabels.includes('b:'), inlayLabels.join(' '));

  const highlights = await vscode.commands.executeCommand('vscode.executeDocumentHighlights', main.uri, position('square_sum'));
  check('the uses of a name are highlighted', (highlights ?? []).length === 4, `${highlights?.length} highlights`);

  const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', main.uri, position('square_sum'), 'sum_square');
  const renames = rename?.get(main.uri) ?? [];
  check(
    'rename keeps the name the function is exported by',
    renames.filter((e) => e.newText === 'sum_square').length === 4 && renames.some((e) => e.newText === '"square_sum" '),
    JSON.stringify(renames.map((e) => e.newText)),
  );

  await write(at('ugly.ents'), 'export   func  g( a:i32 )->i32=>a+1\n');
  const ugly = await vscode.workspace.openTextDocument(at('ugly.ents'));
  // VS Code makes the server's edit of the whole text into the least edits.
  const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', ugly.uri, { tabSize: 2, insertSpaces: true });
  let formatted = ugly.getText();
  for (const e of [...(edits ?? [])].sort((a, b) => ugly.offsetAt(b.range.start) - ugly.offsetAt(a.range.start))) {
    formatted = formatted.slice(0, ugly.offsetAt(e.range.start)) + e.newText + formatted.slice(ugly.offsetAt(e.range.end));
  }
  check('Format Document', formatted === 'export func g(a:i32) -> i32 => a + 1\n', JSON.stringify(formatted));

  // The WAT preview, beside main.ents
  await vscode.window.showTextDocument(main);
  await vscode.commands.executeCommand('encantis.openWatPreviewSide');
  const folded = await previewText(undefined, (t) => t.includes('(module'));
  check('the WAT preview opens', !!folded && folded.includes('square_sum'), folded?.slice(0, 80));
  if (!web) {
    // Optimized by binaryen, which the desktop extension loads from its
    // package (dist/node/binaryen.mjs) the first time
    await vscode.commands.executeCommand('encantis.cycleWatOpt');
    const optimized = await previewText(folded, (t) => t.includes('(module'));
    check('the WAT preview optimizes (-O)', !!optimized && !optimized.includes('error'), optimized?.split('\n').slice(-2).join(' '));
    await vscode.commands.executeCommand('encantis.cycleWatOpt');
    await sleep(1500);
    check('the WAT preview optimizes (release)', !preview()?.getText().includes('error'), preview()?.getText().slice(0, 80));
    await vscode.commands.executeCommand('encantis.cycleWatOpt');
  }

  // An import that is not open is read where it is saved: util.ents without
  // mul, for a file that imports mul from it
  await write(at('util.ents'), 'export func add(a: i32, b: i32) -> i32 => a + b\n');
  await write(at('user.ents'), text);
  const user = await vscode.workspace.openTextDocument(at('user.ents'));
  await vscode.window.showTextDocument(user);
  const notExported = await diagnostics(user.uri, /'mul' is not exported/);
  check('an import that is not open is read', !!notExported, (notExported ?? vscode.languages.getDiagnostics(user.uri)).map((d) => d.message).join(' | '));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`[done] ${results.length - failed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} of ${results.length} checks failed`);
};

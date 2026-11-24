# Encantis for Claude Code

This plugin gives Claude Code's LSP tool the [Encantis](https://github.com/creationix/encantis) language server for `.ents` files:

- After each edit Claude makes to a `.ents` file, it sees the errors and warnings the compiler finds, without running a build.
- It can go to a definition, find references, get the type at a position, list a file's declarations, and search the workspace for a declaration by name.

The plugin runs `encantis lsp`, the same language server as the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=creationix.encantis-vscode-ext).

## Install

1. Get the `encantis` binary for your platform from the [latest release](https://github.com/creationix/encantis/releases/latest) and put it on your `PATH`. Check with `which encantis` in the shell you start `claude` from. `encantis lsp` is in 0.4.0 and later.
2. In Claude Code (2.1.275 or later):

   ```
   /plugin install encantis --marketplace creationix/encantis
   ```

   With an older Claude Code, add the marketplace first:

   ```
   /plugin marketplace add creationix/encantis
   /plugin install encantis@encantis
   ```

   From a shell:

   ```bash
   claude plugin marketplace add creationix/encantis
   claude plugin install encantis@encantis
   ```

3. Run `/reload-plugins` if Claude Code asks you to. The server starts the first time Claude edits a `.ents` file.

## Notes

- **Terminal sessions only.** Claude Code doesn't start plugin language servers in cloud sessions.
- **`Executable not found in $PATH: "encantis"`** in the `/plugin` Errors tab means the binary isn't on the `PATH` of the shell `claude` was started from.
- **If the server keeps crashing,** check `encantis --version`: a release without `encantis lsp` prints its usage instead of serving.
- **Updates.** Claude Code doesn't update third-party marketplaces on its own. Run `/plugin marketplace update encantis`, or turn on auto-update under `/plugin` > Marketplaces. The plugin has no version number, so each commit to it counts as an update.
- **Other editors.** Any LSP client can run the server: `encantis lsp` speaks the protocol on stdin and stdout. It finds the workspace's `.ents` files itself, in the folders the client names when it starts.

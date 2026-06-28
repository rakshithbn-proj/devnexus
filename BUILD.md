# Install DevNexus Locally

Until DevNexus is published to the VS Code Marketplace, you have two options to install it.

---

## Option 1 — Install from GitHub Releases (Recommended)

A prebuilt `.vsix` is attached to each [GitHub Release](https://github.com/rakshithbn-proj/devnexus/releases). No Node.js or build tools required — just VS Code.

### Windows / macOS / Linux

```bash
# Download the latest .vsix
curl -LO https://github.com/rakshithbn-proj/devnexus/releases/latest/download/devnexus-1.0.0.vsix

# Install into VS Code
code --install-extension devnexus-1.0.0.vsix
```

Or download the `.vsix` from the [Releases page](https://github.com/rakshithbn-proj/devnexus/releases) in your browser and install via VS Code:
**Extensions panel → `…` menu → Install from VSIX…**

Then reload VS Code (`Ctrl+Shift+P` → `Developer: Reload Window`).

### Updating

```bash
curl -LO https://github.com/rakshithbn-proj/devnexus/releases/latest/download/devnexus-1.0.0.vsix
code --install-extension devnexus-1.0.0.vsix --force
```

---

## Option 2 — Build from source

Use this if you want to develop DevNexus, modify it, or test unreleased changes from `main`.

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Node.js** | 20+ | https://nodejs.org/ (LTS) |
| **npm** | 10+ | ships with Node.js |
| **VS Code** | 1.95+ | https://code.visualstudio.com/ |
| **VS Code `code` CLI** | — | In VS Code: `Ctrl+Shift+P` → `Shell Command: Install 'code' command in PATH` |
| **Git** | any | only needed to clone the repo |

### One-shot build & install

**Windows**
```bat
git clone https://github.com/rakshithbn-proj/devnexus.git
cd devnexus
build-and-install.bat
```

**macOS / Linux**
```bash
git clone https://github.com/rakshithbn-proj/devnexus.git
cd devnexus
chmod +x build-and-install.sh
./build-and-install.sh
```

The script will:
1. Check prerequisites (`node`, `npm`, `code` CLI)
2. Run `npm ci` (skipped if `node_modules` already exists — delete it to force reinstall)
3. Run `vsce package --no-dependencies` → produces `devnexus-1.0.0.vsix`
4. Run `code --install-extension devnexus-1.0.0.vsix --force`

Then reload VS Code.

### Manual steps

```bash
npm ci
npm run compile
npx @vscode/vsce package --no-dependencies
code --install-extension devnexus-1.0.0.vsix --force
```

---

## npm Dependencies

DevNexus has **zero runtime dependencies** — it uses only the built-in `vscode` API and Node's global `fetch`.

### devDependencies (build-time only)

| Package | Purpose |
|---|---|
| `typescript` ^5.3.0 | TypeScript compiler (`tsc`) |
| `@types/vscode` ^1.95.0 | VS Code API type definitions |
| `@types/node` ^20.11.0 | Node.js type definitions |
| `@vscode/vsce` ^2.22.0 | Packaging CLI (`vsce package`) |

All are pulled in by `npm ci`. No global installs required.

---

## After installing

1. Open **Settings** (`Ctrl+,`) and set:
   - `devnexus.jira.baseUrl` (e.g. `https://jira.example.com`)
   - `devnexus.bitbucket.baseUrl` (e.g. `https://bitbucket.example.com`)
   - `devnexus.bitbucket.project` and `devnexus.bitbucket.repo`
2. Run `DevNexus: Set Jira Credentials` from the Command Palette (`Ctrl+Shift+P`)
3. Run `DevNexus: Set Bitbucket Token`
4. Open **Copilot Chat** and try: `@nexus list my open jira issues`

---

## Uninstalling

```bash
code --uninstall-extension rakshithbn.devnexus
```

Or in VS Code Extensions panel: search `DevNexus` → gear icon → **Uninstall**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `'code' is not recognized` | VS Code CLI not on PATH. In VS Code: `Ctrl+Shift+P` → `Shell Command: Install 'code' command in PATH` |
| `vsce package` fails with TypeScript errors | Run `npm run compile` first to see the actual `tsc` errors |
| Extension installs but `@nexus` doesn't appear | Reload VS Code window and ensure GitHub Copilot Chat is installed and signed in |
| `DevNexus: Jira URL not configured` warning | Open Settings and set `devnexus.jira.baseUrl` |
| `curl: command not found` (older Windows) | Use a browser to download from the [Releases page](https://github.com/rakshithbn-proj/devnexus/releases) |

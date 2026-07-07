# Building DevNexus from Source

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Node.js** | 20+ | https://nodejs.org/ (LTS) |
| **npm** | 10+ | ships with Node.js |
| **Git** | any | only needed to clone the repo |

## Steps

```bash
git clone https://github.com/rakshithbn-proj/devnexus.git
cd devnexus
npm ci
npm run build
```

This compiles TypeScript into `out/`. The server entry point is `out/mcp/server.js`.

## Running the server

```bash
node out/mcp/server.js
```

The server communicates over **stdio** (standard MCP transport). It is not meant to be run directly in a terminal during normal use — your MCP client launches it as a subprocess.

## Development

For faster iteration without a build step, use the `dev` script (requires `tsx`):

```bash
npm run dev
```

## Dependencies

### Runtime

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server SDK |
| `zod` | Tool input schema validation |

### devDependencies (build-time only)

| Package | Purpose |
|---|---|
| `typescript` ^5.3.0 | TypeScript compiler (`tsc`) |
| `@types/node` ^20.11.0 | Node.js type definitions |

## Troubleshooting

| Problem | Fix |
|---|---|
| `tsc` errors after `npm run build` | Ensure Node.js 20+ and run `npm ci` again |
| Server exits immediately | Config file missing or invalid — check `~/.devnexus/config.json` |
| MCP client can't connect | Run `devnexus` in a terminal — if it starts, the binary is on PATH. For source builds, use `npm link` or pass the absolute path to `out/mcp/server.js` directly |

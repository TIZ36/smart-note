# SmartNote Desktop (Electron)

Desktop shell for the SmartNote backend.

## Run

```bash
cd desktop
npm install
npm run electron:dev
```

The UI expects the local gateway at `http://127.0.0.1:8787`.

Start the backend from the project root:

```bash
./scripts/restart-server.sh
```

Production build:

```bash
npm run electron:build
```

## Features

- Search, Raw Input, Tags, Wiki, Versions, Knowledge Graph, Settings
- Native file dialogs, clipboard, open file via Electron preload (`window.desktop`)
- Ingest progress streamed from Python CLI over IPC

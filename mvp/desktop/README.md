# IntelliNote Desktop (Electron)

Desktop shell for the Smart Notes MVP backend.

## Run

```bash
cd desktop
npm install
npm run electron:dev
```

The UI expects the local gateway at `http://127.0.0.1:8787`.

Start the backend in another terminal (from `mvp/`):

```bash
source .venv/bin/activate
python -m app.cli serve --port 8787
```

Production build (renderer + Electron app):

```bash
npm run build
npm run electron:build
```

## Features

- Search, Raw Input, Versions, Sync Rate, topic views, Settings
- Native file dialogs, clipboard, open file via Electron preload (`window.desktop`)
- Ingest progress streamed from Python CLI over IPC

## Quick launch (from `mvp/` root)

- `./start_backend.sh`: venv, deps, gateway
- `./start_desktop.sh`: install npm deps and run `npm run electron:dev`
- `./start_all.sh`: backend + desktop

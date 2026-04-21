# @smartnote/client (TypeScript SDK)

Official TypeScript client for the SmartNote Cloud API.

**Status:** alpha — functional parity with the Python SDK.

## Install

```bash
npm install @smartnote/client
```

## Build

```bash
npm install
npm run build
```

Planned shape:

```ts
import { SmartNote } from "@smartnote/client";

const sn = new SmartNote({ apiKey: "sn_live_..." });
await sn.preferences.set("code_style", "concise");
const { results } = await sn.retrieve({ query: "preferred commit format" });
```

Same responsibilities as the Python SDK: token lifecycle, retries, batching,
typed errors.

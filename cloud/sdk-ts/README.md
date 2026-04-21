# @smartnote/client (TypeScript SDK)

Official TypeScript client for the SmartNote Cloud API.

**Status:** placeholder. Shipping alongside the Python SDK in W3–W4.

Planned shape:

```ts
import { SmartNote } from "@smartnote/client";

const sn = new SmartNote({ apiKey: "sn_live_..." });
await sn.preferences.set("code_style", "concise");
const { results } = await sn.retrieve({ query: "preferred commit format" });
```

Same responsibilities as the Python SDK: token lifecycle, retries, batching,
typed errors.

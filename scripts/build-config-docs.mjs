import { cp, mkdir, rm } from "node:fs/promises";

await rm("docs/config", { force: true, recursive: true });
await mkdir("docs", { recursive: true });
await cp("src/config", "docs/config", { recursive: true });

import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";

await mkdir("dist/server", { recursive: true });
await mkdir("dist/.openai", { recursive: true });
await rm("dist/server/locations-add.js", { force: true });
// Keep the deployed Worker self-contained; the source module remains separately testable.
const additions = (await readFile("locations-add.js", "utf8")).replace(/^export /gm, "");
const worker = (await readFile("index.js", "utf8")).replace(/^import .* from "\.\/locations-add\.js";\n/, "");
await writeFile("dist/server/index.js", additions + "\n" + worker);
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");

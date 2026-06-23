import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const pebble = packageJson.pebble;

const appinfo = {
  uuid: pebble.uuid,
  shortName: pebble.displayName,
  longName: pebble.displayName,
  companyName: packageJson.author,
  versionLabel: packageJson.version,
  sdkVersion: pebble.sdkVersion,
  projectType: "native",
  watchapp: pebble.watchapp,
  capabilities: pebble.capabilities,
  targetPlatforms: pebble.targetPlatforms,
  appKeys: pebble.messageKeys,
  resources: pebble.resources,
};

await writeFile("appinfo.json", `${JSON.stringify(appinfo, null, 2)}\n`);

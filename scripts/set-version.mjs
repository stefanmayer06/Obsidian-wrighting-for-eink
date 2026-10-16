// Sets Ink Notebook's version everywhere it is read: manifest.json (Obsidian
// and BRAT), package.json, package-lock.json and versions.json.
//
//   npm run set-version -- 1.3.1
//
// The release workflow runs it with the pushed tag, so a release's
// manifest.json always matches its tag (BRAT and Obsidian compare the two).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`"${version}" is not a plugin version. Use the form 1.2.3 – Obsidian needs the release tag to be exactly the version, without a "v".`);
  process.exit(1);
}

const file = (name) => path.join(root, name);

/** Replace the first `count` "version" fields, keeping the file's formatting. */
function setVersionField(name, count) {
  let found = 0;
  const text = fs.readFileSync(file(name), "utf8").replace(/("version":\s*")[^"]*"/g, (match, start) => (found++ < count ? `${start}${version}"` : match));
  if (found < count) throw new Error(`${name}: expected ${count} "version" field(s), found ${found}`);
  fs.writeFileSync(file(name), text);
}

setVersionField("manifest.json", 1);
setVersionField("package.json", 1);
setVersionField("package-lock.json", 2); // the lockfile repeats it for the root package

const { minAppVersion } = JSON.parse(fs.readFileSync(file("manifest.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(file("versions.json"), "utf8"));
versions[version] = minAppVersion;
fs.writeFileSync(file("versions.json"), `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Ink Notebook ${version} (needs Obsidian ${minAppVersion} or newer)`);

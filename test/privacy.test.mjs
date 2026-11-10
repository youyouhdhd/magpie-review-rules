import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const metadata = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

test("published metadata contains no personal identity or account links", () => {
  for (const key of ["author", "contributors", "maintainers", "_npmUser", "email", "repository", "homepage", "bugs"]) {
    assert.equal(Object.hasOwn(metadata, key), false, `${key} must not be bundled`);
  }
});

test("release files exclude account records, local paths and generated data", async () => {
  assert.deepEqual(metadata.files, [
    "engine.js", "middleware.js", "host.mjs", "install.ps1",
    "page/index.html", "page/app.js", "page/style.css", "page/icon.svg",
  ]);
  for (const path of ["package.json", "README.md", "LICENSE", ...metadata.files]) {
    const content = await readFile(new URL(path, root), "utf8");
    assert.doesNotMatch(content, /[A-Z]:\\Users\\|\/Users\/[^/]+|\/home\/[^/]+/i, `${path}: personal path`);
    assert.doesNotMatch(content, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, `${path}: email address`);
    assert.doesNotMatch(content, /auth-and-writes|\/auth\/cli\/|\b2fa\b/i, `${path}: account state`);
    assert.doesNotMatch(content, /https?:\/\/(?:www\.)?github\.com\/(?!magpie-community\/)[^/\s)]+/i, `${path}: personal account link`);
    assert.doesNotMatch(content, /(?:npmjs\.com\/(?:~|settings\/))/, `${path}: publisher profile`);
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const endpoint = process.env.RMCH_TEST_ENDPOINT || "http://127.0.0.1:19436";
async function command(type, args = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({ type, args }),
    signal: AbortSignal.timeout(30000)
  });
  const value = await response.json();
  assert.equal(value.ok, true, value.error || type);
  return value.out;
}

const kinds = [
  "item",
  "weapon",
  "armor",
  "skill",
  "state",
  "actor",
  "enemy",
  "troop",
  "mapInfo",
  "commonEvent"
];
const results = await Promise.all(
  kinds.map(async (kind) => {
    const catalog = await command("catalog.query", { kind, limit: 20000 });
    assert.ok(catalog.total > 0, kind + " has data");
    assert.equal(
      catalog.entries.length,
      catalog.total,
      kind + " is not truncated"
    );
    assert.ok(
      catalog.entries.some((entry) => entry.name),
      kind + " has decoded names"
    );
    return {
      kind,
      total: catalog.total,
      examples: catalog.entries.filter((entry) => entry.name).slice(0, 3)
    };
  })
);
const iconset = await command("assets.iconset");
assert.ok(iconset.width > 0 && iconset.height > 0);
assert.match(iconset.dataUrl, /^data:image\/png;base64,/);
const bytes = Buffer.from(iconset.dataUrl.split(",")[1], "base64");
assert.equal(bytes.subarray(1, 4).toString(), "PNG");
const runtime = await command("runtime.info");
assert.equal(runtime.engine.maker, "MV");
assert.equal(runtime.engine.title, "末日风暴");
const scene = await command("console.eval", {
  code: "({scene:SceneManager._scene&&SceneManager._scene.constructor.name,frame:Graphics.frameCount,stopped:SceneManager._stopped,hidden:document.hidden})"
});
const output = {
  checkedAt: new Date().toISOString(),
  runtime,
  catalogs: results,
  iconset: {
    width: iconset.width,
    height: iconset.height,
    bytes: bytes.length
  },
  scene: scene.result
};
fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
fs.writeFileSync(
  path.join(root, "tmp/storm-readonly-acceptance.json"),
  JSON.stringify(output, null, 2)
);
fs.writeFileSync(path.join(root, "tmp/storm-iconset.png"), bytes);
console.log(
  JSON.stringify({
    catalogs: results.map(({ kind, total }) => ({ kind, total })),
    iconset: output.iconset,
    scene: output.scene
  })
);

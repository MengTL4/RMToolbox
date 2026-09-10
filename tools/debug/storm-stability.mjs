// Read-only observation of the live dedicated acceptance session.
import fs from "node:fs";
const endpoint = process.env.RMCH_TEST_ENDPOINT || "http://127.0.0.1:19436";
const samples = [];
for (let i = 0; i < 19; i++) {
  const response = await (
    await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({
        type: "console.eval",
        args: {
          code: "({at:Date.now(),scene:SceneManager._scene&&SceneManager._scene.constructor.name,frame:Graphics.frameCount,hidden:document.hidden,stopped:!!SceneManager._stopped,delta:SceneManager._deltaTime})"
        }
      }),
      signal: AbortSignal.timeout(15000)
    })
  ).json();
  if (!response.ok) throw Error(response.error);
  samples.push(response.out.result);
  fs.mkdirSync("tmp", { recursive: true });
  fs.writeFileSync(
    "tmp/storm-stability.json",
    JSON.stringify(samples, null, 2)
  );
  if (i < 18) await new Promise((resolve) => setTimeout(resolve, 5000));
}
console.log(
  JSON.stringify({
    samples: samples.length,
    elapsed: samples.at(-1).at - samples[0].at,
    foregroundSamples: samples.filter((x) => !x.hidden).length,
    stoppedSamples: samples.filter((x) => x.stopped).length
  })
);

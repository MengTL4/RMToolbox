// Attach to the RUNNING plain-launched game (no bootTap, no dance) and report.
import { attachGame } from "../core/attach.mjs";
try {
  const r = await attachGame({
    gameRoot: "D:\\Downloads\\RPG\\_V1.2.2_B电脑端",
    projectRoot: "E:\\project\\RMToolbox",
    port: 47412
  });
  console.log("ATTACH OK", JSON.stringify({ strategy: r.strategy, injected: r.injected }));
} catch (e) {
  console.log("ATTACH FAIL", e && e.message);
  process.exit(1);
}
setTimeout(() => process.exit(0), 2000);

import { scanGame } from "../../core/scanner.mjs";
import { planLaunch } from "../../core/launch-plan.mjs";

const scan = scanGame(process.argv[2]);
console.log(
  JSON.stringify(
    {
      engine: scan.engine,
      container: scan.container,
      protection: scan.protection,
      title: scan.title,
      gameKey: scan.gameKey,
      exe: scan.paths.exe,
      layout: scan.layout
    },
    null,
    2
  )
);
console.log("launch plan:", JSON.stringify(planLaunch(scan), null, 2));

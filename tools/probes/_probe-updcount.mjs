// Find which class's update actually drives frames after a load.
import path from "node:path";
import { launchRgssGame } from "../../core/rgss-launcher.mjs";

const gameRoot = path.resolve(process.argv[2]);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const gameKey = path
  .basename(gameRoot)
  .replace(/[^a-z0-9_-]+/gi, "_")
  .slice(0, 60);
const handle = await launchRgssGame({ gameRoot, projectRoot, gameKey });
const { session } = handle;
console.log("connected");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (code) =>
  session
    .send("debug.eval", { code }, 20000)
    .then((p) => console.log(">>", code.slice(0, 100), "\n  ", p.result))
    .catch((e) =>
      console.log(">>", code.slice(0, 100), "\n   FAIL", e.message)
    );

await session
  .send("save.load", { id: 1 }, 30000)
  .then(() => console.log("loaded"));
await sleep(4000);
await ev(`$__cnt = Hash.new(0)
ObjectSpace.each_object(Class) do |c|
  n = c.name rescue nil
  next if n.nil? || n.empty?
  next unless c.method_defined?(:update) rescue next
  begin
    c.prepend(Module.new do
      define_method(:update) do |*a|
        $__cnt[self.class.name] += 1
        super(*a)
      end
    end)
  rescue Exception
  end
end
"armed"`);
await sleep(2000);
await ev("$__cnt.select { |k, v| v > 0 }.inspect");
await ev('$scene.class.name + " / updates=" + $__cnt[$scene.class.name].to_s');

handle.stop();
process.exit(0);

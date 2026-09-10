// Game module monitors can mistake installed VPN/font components for injected
// game modifications and quit even on an untouched launch.
import { readFileSync } from "node:fs";
import path from "node:path";
export const GROVER_BRIDGE_READY_MS = 60000;

export function isKnownSangforModule(
  value,
  programFiles = process.env["ProgramFiles(x86)"]
) {
  if (!programFiles) return false;
  const prefix =
    path.win32.join(programFiles, "Sangfor", "SSL").toLowerCase() + "\\";
  const full = path.win32.normalize(String(value)).toLowerCase();
  if (!full.startsWith(prefix)) return false;
  const rel = full.slice(prefix.length);
  return (
    /^sangforpwex\\sangforudprotectex_[0-9]+[.]dll$/.test(rel) ||
    [
      "sangforpwex\\sangforvpnlibcrypto-1_1.dll",
      "clientcomponent\\sangfortcp.dll",
      "clientcomponent\\5_sangfornsp.dll"
    ].includes(rel)
  );
}

export function isKnownMacTypeModule(value) {
  const full = path.win32.normalize(String(value)).toLowerCase();
  return (
    path.win32.basename(path.win32.dirname(full)) === "mactype" &&
    ["mactype.dll", "mactype.core.dll"].includes(path.win32.basename(full))
  );
}

export function isKnownCompatibilityModule(value) {
  return isKnownSangforModule(value) || isKnownMacTypeModule(value);
}

// Shadow startup runs before SceneManager exists, so report compatibility must
// not depend on the later bridge or engine readiness.
export function buildModuleReportCompatibility() {
  return `(function(){try{
    var path=require('path'),report=process.report;
    if(!report||typeof report.getReport!=='function'||process.__rmchKnownModuleReport)return;
    ${isKnownSangforModule.toString()}
    ${isKnownMacTypeModule.toString()}
    ${isKnownCompatibilityModule.toString()}
    var original=report.getReport;
    var modules=(original.call(report)||{}).sharedObjects;
    if(!Array.isArray(modules)||!modules.some(isKnownCompatibilityModule))return;
    report.getReport=function(){var value=original.apply(this,arguments);if(value&&Array.isArray(value.sharedObjects))value.sharedObjects=value.sharedObjects.filter(function(module){return !isKnownCompatibilityModule(module)});return value;};
    process.__rmchKnownModuleReport=true;
  }catch(_){}})();`;
}

export function hasGroverModuleMonitor(jsDir) {
  try {
    const bytes = readFileSync(path.join(jsDir, "plugins", "TH-QianC.js"));
    return ["modulesMmt", "sharedObjects", "Suspect Module =>"].every((s) =>
      bytes.includes(Buffer.from(s))
    );
  } catch (_) {
    return false;
  }
}

export function buildGroverCompatibilityBootstrap(
  statusPath,
  { delayedBootstrapPath = null, delayMs = 60000, matchedModules = null } = {}
) {
  // Only the observed Sangfor components and the two MacType font DLLs qualify.
  // This does not change DLL loading or stop any component.
  return `(function(){
    if(typeof window==='undefined'||!window.SceneManager)throw Error('rmch-not-game-page');
    var gameWindow=window;
    var fs=require('fs'),path=require('path'),report=process.report;
    var statusPath=${JSON.stringify(statusPath)};
    var bootstrapPath=${JSON.stringify(delayedBootstrapPath)};
    function status(value){try{fs.mkdirSync(path.dirname(statusPath),{recursive:true});fs.writeFileSync(statusPath,JSON.stringify(value));}catch(_){}}
    function observe(phase){try{var sm=gameWindow.SceneManager;fs.appendFileSync(statusPath+'.runtime.jsonl',JSON.stringify({phase:phase,at:Date.now(),href:gameWindow.location.href,closed:gameWindow.closed,hidden:gameWindow.document.hidden,scene:sm&&sm._scene&&sm._scene.constructor.name,frame:gameWindow.Graphics&&gameWindow.Graphics.frameCount,lexicalScene:typeof SceneManager!=='undefined'&&SceneManager._scene&&SceneManager._scene.constructor.name})+'\\n');}catch(e){try{fs.appendFileSync(statusPath+'.runtime.jsonl',JSON.stringify({phase:phase,error:String(e)})+'\\n')}catch(_){}}}
    observe('compatibility-entry');
    function ready(w){var s=w&&w.SceneManager&&w.SceneManager._scene;return w&&!w.closed&&w.$dataSystem&&s&&s.constructor.name!=='Scene_Boot';}
    function later(){${
      delayedBootstrapPath
        ? `
      if(gameWindow.__rmchGroverBridgeScheduled)return;
      gameWindow.__rmchGroverBridgeScheduled=true;
      var timers=require('timers'),nwWindows=nw.Window;
      timers.setTimeout(function(){
        observe('bridge-timer-fired');
        try{
          if(ready(gameWindow)){
            observe('before-bridge');gameWindow.eval(fs.readFileSync(bootstrapPath,'utf8'));
            timers.setTimeout(function(){observe('after-bridge');},1000);return;
          }
        }catch(e){status({status:'bridge-error',error:String(e)});return;}
        var deadline=Date.now()+${GROVER_BRIDGE_READY_MS},done=false;
        var poll=timers.setInterval(function(){
          if(done)return;
          if(Date.now()>deadline){done=true;timers.clearInterval(poll);status({status:'bridge-error',error:'No game window became ready'});return;}
          nwWindows.getAll(function(windows){
            if(done)return;
            var target=windows.find(function(w){try{return w.window&&/[/]www[/]index[.]html/.test(w.window.location.href)&&ready(w.window);}catch(e){return false;}});
            if(!target)return;
            done=true;timers.clearInterval(poll);gameWindow=target.window;
            try{target.show();target.restore();target.focus();observe('before-bridge');target.eval(null,fs.readFileSync(bootstrapPath,'utf8'));timers.setTimeout(function(){observe('after-bridge');},1000);}
            catch(e){status({status:'bridge-error',error:String(e)});}
          });
        },250);
      },${JSON.stringify(delayMs)});
    `
        : ""
    }}
    if(window.__rmchGroverCompatibility){later();return;}
    if(!report||typeof report.getReport!=='function'){status({status:'unavailable'});return;}
    var original=report.getReport;
    var base=process.env['ProgramFiles(x86)'];
    var prefix=base?path.win32.join(base,'Sangfor','SSL').toLowerCase()+'\\\\':'';
    ${isKnownMacTypeModule.toString()}
    function known(value){
      if(isKnownMacTypeModule(value))return true;
      var full=path.win32.normalize(String(value)).toLowerCase();
      if(!prefix||full.indexOf(prefix)!==0)return false;
      var rel=full.slice(prefix.length);
      return /^sangforpwex\\\\sangforudprotectex_[0-9]+[.]dll$/.test(rel)||
        rel==='sangforpwex\\\\sangforvpnlibcrypto-1_1.dll'||
        rel==='clientcomponent\\\\sangfortcp.dll'||rel==='clientcomponent\\\\5_sangfornsp.dll';
    }
    var modules=${matchedModules ? JSON.stringify(matchedModules) : "(original.call(report)||{}).sharedObjects"};
    var matched=Array.isArray(modules)?modules.filter(known):[];
    if(!matched.length){status({status:'skipped',reason:'no-known-modules'});later();return;}
    report.getReport=function(){var value=original.apply(this,arguments);if(value&&Array.isArray(value.sharedObjects))value.sharedObjects=value.sharedObjects.filter(function(p){return !known(p)});return value;};
    window.__rmchGroverCompatibility={version:1,modules:matched.map(function(p){return path.win32.basename(p)})};
    status({status:'applied',modules:window.__rmchGroverCompatibility.modules});
    later();
  })();`;
}

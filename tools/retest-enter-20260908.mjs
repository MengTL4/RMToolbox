// Complete native introduction screens on a marked disposable test copy.
export async function enter({ send, ev, sleep, rgss }) {
  if (rgss) {
    await ev(
      "DataManager.setup_new_game; SceneManager.goto(Scene_Map); true"
    ).catch(() => {});
    await sleep(2000);
    return;
  }
  for (let n = 0; n < 100; n++) {
    if ((await send("party.info").catch(() => null))?.members?.length) return;
    await ev(`(function(){var t=window.TK&&TK.$,m=t&&(t.SceneMrg||t.SceneManager)||window.SceneManager,s=m&&m._scene;if(!s)return 'no scene';var name=s.constructor.name;
   if(name==='Scene_SetSave'){if(s._confirmWindow&&s._confirmWindow.active&&s.onConfirmOk){s.onConfirmOk();return 'confirm isolated slot';}if(s._listWindow&&s.onSavefileOk){s._listWindow.select(s._listWindow.maxItems()-1);s.onSavefileOk();return 'select isolated slot';}}
   if(name==='Scene_Name'&&s.onInputOk){s.onInputOk();return 'confirm default name';}
   var w=s._messageWindow;if(w){if(w._choiceWindow&&w._choiceWindow.active){w._choiceWindow.select(0);w._choiceWindow.processOk();return 'first choice';}if(w.pause){w.pause=false;if(!w._textState)w.terminateMessage();return 'advance message';}if(w._textState)w._showFast=true;}
   return name;})()`).catch(() => {});
    await sleep(300);
  }
}

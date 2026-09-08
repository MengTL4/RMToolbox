  // Owned executions use the game's idle main interpreter, never a timer-driven
  // imitation of its wait/scene machinery. Only our update call gets a context.
  let exSession = null, exContext = null, exSequence = 0;
  const exPatched = new WeakMap(), exStopSignal = {};
  const exEnds = {102:404,111:412,112:413,301:604};
  const exContinuations = {101:401,105:405,108:408,205:505,302:605,355:655,357:657};
  const exMarkers = new Set([401,402,403,404,405,408,411,412,413,505,601,602,603,604,605,655,657]);
  function exScript(command) {
    const p=command.parameters||[],code=command.code;
    return [355,356,357].includes(code) || (code===111 && p[0]===12) || (code===122 && p[3]===4) ||
      (code===205 && p[1] && Array.isArray(p[1].list) && p[1].list.some(move=>move.code===45));
  }
  function exEffectsPending(session) { return Array.from(session.effects).some(target=>target.isMoveRouteForcing && target.isMoveRouteForcing()); }
  function exMain() { const map=requireMap(); return map._interpreter; }
  function exActive() { return exSession && !['completed','stopped','failed'].includes(exSession.state); }
  function exPublic() {
    if (!exSession) return {execution:null};
    const {id,eventId,name,start,end,state,reason,index,commandEventId,stopRequested}=exSession;
    return {execution:{id,eventId,name,start,end,state,reason,index,commandEventId,stopRequested}};
  }
  function exSteps(list) {
    const steps=[];
    function endAt(start) {
      const first=list[start], depth=first.indent || 0, ending=exEnds[first.code];
      if (ending) {
        if(first.code===301 && ![601,602,603].includes(list[start+1] && list[start+1].code)) return start+1;
        for(let i=start+1;i<list.length;i++) {
          if(list[i].code===ending && (list[i].indent||0)===depth) return i+1;
          if((list[i].indent||0)<depth) throw Error('事件结构缺少结束指令');
        }
        // Battle processing without result branches is a single command.
        if(first.code===301 && (!list[start+1] || ![601,602,603].includes(list[start+1].code))) return start+1;
        throw Error('事件结构缺少结束指令');
      }
      let end=start+1;
      while(exContinuations[first.code] && list[end] && list[end].code===exContinuations[first.code] && (list[end].indent||0)===depth) end++;
      if(first.code===101 && list[end] && [102,103,104].includes(list[end].code) && (list[end].indent||0)===depth) end=endAt(end);
      return end;
    }
    for(let i=0;i<list.length;) {
      if(list[i].code===0) { i++; continue; }
      let end=i+1, reason=null;
      try {
        if((list[i].indent||0)!==0 || exMarkers.has(list[i].code)) throw Error('只能执行完整结构，不能单独执行内部行或续行');
        end=endAt(i);
      } catch(error) { reason=error.message; }
      steps.push({start:i,end,code:list[i].code,reason}); i=end;
    }
    return steps;
  }
  function exUnsupported(list, interpreter) {
    const stack=[], labels=new Set(list.filter(c=>c.code===118).map(c=>String(c.parameters[0])));
    for(const [i,c] of list.entries()) {
      const p=c.parameters||[], depth=c.indent||0, code=c.code;
      if(exEnds[code] && (code!==301 || [601,602,603].includes(list[i+1] && list[i+1].code))) stack.push({code,depth});
      if([404,412,413,604].includes(code)) {
        const top=stack.pop();
        if(!top || exEnds[top.code]!==code || top.depth!==depth) return '事件结构不完整';
      }
      if(code===113 && !stack.some(entry=>entry.code===112)) return '跳出循环缺少所属循环';
      if(code===119 && !labels.has(String(p[0]))) return '标签跳转超出所选步骤范围';
      if(code===123 || code===214 || (code===111 && (p[0]===2 || (p[0]===6 && p[1]===0))) ||
        ([203,205,212,213].includes(code) && p[0]===0) ||
        (code===122 && p[3]===3 && p[4]===5 && p[5]===0)) return '该步骤需要地图事件调用上下文';
      if(code!==0 && !exMarkers.has(code) && typeof interpreter['command'+code]!=='function') return '当前引擎不支持指令 #'+code;
    }
    if(stack.length) return '事件结构不完整';
    return null;
  }
  function exDefinition(id, interpreter) {
    const table=runtimeDataTable('commonEvent'), event=table[id];
    if(!event || !Array.isArray(event.list)) throw Error('公共事件不存在或无法读取');
    const dependencies={}, originals={}, visiting=new Set(); let script=false, count=0;
    function capture(eventId) {
      if(visiting.has(eventId)) throw Error('递归公共事件调用暂不支持选步执行');
      if(dependencies[eventId]) return;
      const entry=table[eventId]; if(!entry || !Array.isArray(entry.list)) throw Error('调用的公共事件不存在：#'+eventId);
      count+=entry.list.length; if(count>20000) throw Error('事件及其调用超过 20000 条指令');
      visiting.add(eventId);
      const text=JSON.stringify(entry.list); originals[eventId]=text;
      const list=JSON.parse(text);
      dependencies[eventId]=list;
      for(const c of list) {
        if(exScript(c)) script=true;
        if(c.code===117) capture(Number(c.parameters[0]));
      }
      visiting.delete(eventId);
    }
    // Analyze each selectable root separately, so an unrelated unsupported step
    // never prevents executing a plain gold or text command.
    return {event, table, dependencies, originals, capture, hasScript:()=>script};
  }
  function exPlan(id, start, whole=false, rootHash=null, knownStep=null) {
    const interpreter=exMain();
    if(!interpreter || !['update','executeCommand','setup','isRunning'].every(k=>typeof interpreter[k]==='function')) throw Error('当前游戏的事件执行接口不受支持');
    const def=exDefinition(id,interpreter), list=def.event.list;
    if(list.length>20000) throw Error('事件超过 20000 条指令');
    const step=whole ? {start:0,end:list.length} : knownStep || exSteps(list).find(s=>s.start===Number(start));
    if(!step || step.reason) throw Error(step && step.reason || '请选中完整事件步骤');
    const chosen=JSON.parse(JSON.stringify(list.slice(step.start,step.end)));
    let scripts=false;
    for(const c of chosen) {
      if(c.code===117) def.capture(Number(c.parameters[0]));
      if(exScript(c)) scripts=true;
    }
    for(const sequence of [chosen,...Object.values(def.dependencies)]) {
      const problem=exUnsupported(sequence,interpreter); if(problem) throw Error(problem);
    }
    const revision=etHash([rootHash || etHash(list),def.originals]);
    const script=scripts||def.hasScript(), preview=script?JSON.stringify({commands:chosen,calledEvents:def.dependencies},null,2):'';
    if(preview.length>131072) throw Error('脚本确认内容超过 128K 字符，暂不支持执行');
    return {id,name:def.event.name||'',...step,revision,script,preview,list:chosen,dependencies:def.dependencies,interpreter};
  }
  function exFinish(state, reason='') { if(exSession) { exSession.state=state; exSession.reason=reason; } }
  function exInstall(interpreter) {
    const prototype=Object.getPrototypeOf(interpreter);
    if(exPatched.has(prototype)) {
      const installed=exPatched.get(prototype);
      if(prototype.update!==installed.update || prototype.executeCommand!==installed.execute || prototype.command117!==installed.common) throw Error('游戏替换了事件执行接口，请重新注入后重试');
      return;
    }
    const originalUpdate=prototype.update, originalExecute=prototype.executeCommand, originalCommon=prototype.command117;
    if(typeof originalUpdate!=='function' || typeof originalExecute!=='function') throw Error('自定义解释器无法接管工具执行');
    function update() {
      if(!exActive() || this!==exSession.interpreter) return originalUpdate.apply(this,arguments);
      if(exContext) return; // Modal re-entry must not resume the same interpreter.
      const session=exSession; session.budget=200; exContext=session;
      session.state=session.stopRequested?'stopping':'running';
      try {
        originalUpdate.apply(this,arguments);
        if(!this.isRunning()) exFinish(session.stopRequested?'stopped':'completed');
        else if(this._list!==session.root) exFinish('failed','游戏替换了本次执行，状态无法继续核实');
        else if(this._waitCount>0 || this._waitMode || this._childInterpreter || exEffectsPending(session)) session.state=session.stopRequested?'stopping':'waiting';
      } catch(error) {
        if(this._list===session.root) { this.clear ? this.clear() : this.terminate(); }
        exFinish(error===exStopSignal?'stopped':'failed',error===exStopSignal?'':String(error.message||error));
      } finally { exContext=null; }
    }
    function execute() {
      const session=exContext;
      if(!session || !exActive()) return originalExecute.apply(this,arguments);
      if(!session.lists.has(this._list)) {
        if(session.scriptConfirmed && this!==session.interpreter) return originalExecute.apply(this,arguments);
        throw Error('运行中的指令来源已改变');
      }
      const command=this.currentCommand();
      if((session.stopRequested || (this===session.interpreter && (!command || command.code===115 || this._index>=this._list.length-1))) && exEffectsPending(session)) return false;
      if(session.stopRequested) throw exStopSignal;
      if(--session.budget<0) return false;
      const origin=session.lists.get(this._list);
      session.index=origin.offset+this._index; session.commandEventId=origin.id;
      const target=command && command.code===205 && this.character ? this.character(command.parameters[0]) : null;
      const result=originalExecute.apply(this,arguments);
      if(target && target.isMoveRouteForcing && target.isMoveRouteForcing()) session.effects.add(target);
      return result;
    }
    prototype.update=update; prototype.executeCommand=execute;
    prototype.command117=function() {
      if(!exContext || !exActive()) return originalCommon.apply(this,arguments);
      const params=Array.isArray(arguments[0])?arguments[0]:this._params;
      const id=Number(params[0]), list=exContext.dependencies[id];
      if(!list) {
        if(exContext.scriptConfirmed) return originalCommon.apply(this,arguments);
        throw Error('公共事件调用不在已验证范围内');
      }
      const child=new this.constructor((this._depth||0)+1);
      child.setup(list,0);
      if(child.setEventInfo)child.setEventInfo({eventType:'common_event',commonEventId:id});
      this._childInterpreter=child; return true;
    };
    exPatched.set(prototype,{update,execute,common:prototype.command117});
  }
  function exStart(args, whole=false) {
    etCheck(args);
    if(exActive()) throw Error('该游戏已有工具事件在运行');
    const busy=etBusy(); if(busy) throw Error(busy.replace(/不能传送/g,'不能启动事件'));
    const temp=resolveTemp();
    if(temp && ((temp.isCommonEventReserved && temp.isCommonEventReserved()) || temp._commonEventId>0)) throw Error('游戏已有待执行的公共事件');
    const plan=exPlan(Number(args.id),Number(args.start),whole);
    if(args.revision!==plan.revision) throw Error('事件内容已变化，请重读步骤');
    if(plan.script && args.confirmed!==true) throw Error('脚本或插件命令需要确认原文后执行');
    exInstall(plan.interpreter);
    const root=plan.list.concat([{code:0,indent:0,parameters:[]}]), lists=new Map([[root,{id:plan.id,offset:plan.start}]]);
    for(const [id,list] of Object.entries(plan.dependencies)) lists.set(list,{id:Number(id),offset:0});
    exSession={id:'execution:'+Date.now()+':'+(++exSequence),eventId:plan.id,name:plan.name,start:plan.start,end:plan.end,
      state:'accepted',reason:'',index:plan.start,commandEventId:plan.id,stopRequested:false,scriptConfirmed:plan.script && args.confirmed===true,interpreter:plan.interpreter,root,lists,effects:new Set(),dependencies:plan.dependencies};
    try {
      plan.interpreter.setup(root,0);
      if(plan.interpreter.setEventInfo)plan.interpreter.setEventInfo({eventType:'common_event',commonEventId:plan.id});
    } catch(error) { exFinish('failed',error.message); throw error; }
    return exPublic();
  }
  Object.assign(commandHandlers,{
    'events.steps':args=>{
      etCheck(args); const id=Number(args.id), event=runtimeDataTable('commonEvent')[id];
      if(!event || !Array.isArray(event.list)) throw Error('公共事件不存在');
      if(event.list.length>20000) throw Error('事件超过 20000 条指令');
      const rootHash=etHash(event.list);
      const steps=exSteps(event.list).map(step=>{
        if(step.reason) return step;
        try { const plan=exPlan(id,step.start,false,rootHash,step); return {...step,revision:plan.revision,script:plan.script}; }
        catch(error) { return {...step,reason:error.message}; }
      });
      let whole; try {const plan=exPlan(id,0,true);whole={revision:plan.revision,script:plan.script};}catch(error){whole={reason:error.message};}
      return {mapToken:args.mapToken,id,name:event.name,readerRevision:etReadSource({mapToken:args.mapToken,kind:'common',id}).revision,steps,whole};
    },
    'events.preview':args=>{etCheck(args);const plan=exPlan(Number(args.id),Number(args.start),args.whole===true);if(plan.revision!==args.revision)throw Error('事件内容已变化，请重读');return {preview:plan.preview};},
    'events.execute':args=>exStart(args,args.whole===true),
    'events.execution':()=>{
      if(exActive() && exMain()!==exSession.interpreter) exFinish('failed','游戏重载了执行上下文，无法继续核实');
      return exPublic();
    },
    'events.stop':args=>{
      if(!exSession || args.executionId!==exSession.id) throw Error('执行身份已变化，请刷新');
      if(exActive()) {exSession.stopRequested=true;exSession.state='stopping';}
      return exPublic();
    },
    'commonEvent.run':args=>exStart(args,true)
  });

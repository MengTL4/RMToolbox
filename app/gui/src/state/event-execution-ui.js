import { h } from 'vue';
export const executionLabels = {accepted:'已接受',running:'运行中',waiting:'等待游戏操作结束',stopping:'等待当前操作结束后停止',completed:'已完成',stopped:'已停止',failed:'执行失败',unknown:'结果无法核实'};
export const executionActive = execution => ['accepted','running','waiting','stopping'].includes(execution?.state);
export async function confirmExecution(tools, plan, whole, dialog, host) {
  const epoch=host.state.selectionEpoch;
  try {
    const args=tools.executionArgs(plan,whole);
    if(plan.script) {
      const result=await tools.preview(args);
      if(epoch!==host.state.selectionEpoch) return;
      dialog.warning({title:'确认执行脚本 / 插件命令 · 公共事件 #'+args.id,
        content:()=>h('div',[h('p','这些指令可能修改数据或调用其他事件。以下为游戏端原文，执行后不自动回滚。'),h('pre',{style:'max-height:45vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px'},result.preview)]),
        positiveText:'确认执行',negativeText:'取消',onPositiveClick:()=>tools.execute({...args,confirmed:true})});
    } else await tools.execute(args);
  } catch(error) {if(epoch===host.state.selectionEpoch)host.warn(error.message);}
}

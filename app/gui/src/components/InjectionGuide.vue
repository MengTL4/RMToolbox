<template>
  <n-alert title="两种注入方式" type="info" :bordered="false">
    <div><strong>① 启动并注入：</strong>游戏还没打开时，点击「启动并注入」，由工具箱启动游戏并注入。</div>
    <div><strong>② 先打开游戏，再注入：</strong>自己先打开游戏，再点击对应卡片的「附加到运行中」。</div>
    <n-text depth="3" style="font-size: 12px">部分游戏仅支持其中一种方式，或需要接管重启，以卡片上的入口和提示为准。</n-text>
  </n-alert>
</template>

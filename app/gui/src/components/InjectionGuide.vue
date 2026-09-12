<template>
  <n-alert title="两种注入方式" type="info" :bordered="false">
    <div>
      <strong>① 启动并注入：</strong
      >游戏还没打开时，点击「启动并注入」，由工具箱启动游戏并注入。
    </div>
    <div>
      <strong>② 先打开游戏，再注入：</strong
      >自己先打开游戏，再点击对应卡片的「附加到运行中」。
    </div>
    <div>
      <strong>按钮括号里写的是它实际会做的事。</strong
      >个别壳（黑名单/防篡改）一旦收到启动参数就自杀，工具箱只能
      <n-text code>裸启动</n-text>游戏再注入
      DLL，不会重开游戏、也不会改游戏文件；括号里会写明这一点。
    </div>
    <n-text depth="3" style="font-size: 12px"
      >部分游戏仅支持其中一种方式，或需要接管重启，以卡片上的入口和提示为准。</n-text
    >
  </n-alert>
</template>

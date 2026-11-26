/* Минимальный preload: без доступа к Node, только безопасные API окна. */
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('darkarmyDesktop', {
  isDesktop: true,
  platform: process.platform,
});

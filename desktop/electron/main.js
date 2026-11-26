/* Electron-обёртка DarkArmy Dossier.
   По умолчанию открывает локальный сервер. Можно указать свой адрес:
   DOSSIER_URL=https://dossier.example.com
*/
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('path');

const BASE = process.env.DOSSIER_URL || 'http://127.0.0.1:7561';
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'DarkArmy Dossier',
    icon: path.join(__dirname, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadURL(BASE).catch(async () => {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'DarkArmy Dossier',
      message: 'Не удалось подключиться к серверу',
      detail: `Адрес: ${BASE}\n\nЗапустите сервер (npm start) или задайте DOSSIER_URL.`,
      buttons: ['Повторить', 'Выход'],
    });
    win.loadURL(BASE).catch(() => {});
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(BASE) && !url.startsWith('http://127.0.0.1:7561')) e.preventDefault();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

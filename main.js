const { app, BrowserWindow, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true
  });

  win.maximize();
  win.loadURL("https://gen-lang-client-0894510834.web.app");
}

app.whenReady().then(() => {
  createWindow();

  autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on("update-available", () => {
  dialog.showMessageBox({
    type: "info",
    title: "Mise à jour",
    message: "Une mise à jour est disponible.",
    buttons: ["OK"]
  });
});

autoUpdater.on("update-downloaded", () => {
  dialog.showMessageBox({
    type: "info",
    title: "Installer",
    message: "Mise à jour téléchargée. Installer maintenant ?",
    buttons: ["Oui", "Plus tard"]
  }).then(result => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});
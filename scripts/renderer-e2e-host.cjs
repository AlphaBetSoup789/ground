const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const projectRoot = path.resolve(__dirname, '..')

app.commandLine.appendSwitch('disable-background-timer-throttling')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1_280,
    height: 900,
    minWidth: 480,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  await window.loadFile(path.join(projectRoot, 'preview-dist', 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})

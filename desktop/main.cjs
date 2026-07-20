const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (require('electron-squirrel-startup')) app.quit();

let mainWindow;
let setupWindow;
let runtime;
let quitting = false;

function preferencesPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function readPreferences() {
  try {
    return JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writePreferences(preferences) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(preferencesPath(), `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
}

function decryptPassword(preferences) {
  if (!preferences?.encryptedPassword) return '';
  return safeStorage.decryptString(Buffer.from(preferences.encryptedPassword, 'base64'));
}

function directoryExists(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function validateSetup(input, existing) {
  const moviesPath = String(input?.moviesPath || '').trim();
  const tvPath = String(input?.tvPath || '').trim();
  const baseUrl = String(input?.baseUrl || '').trim().replace(/\/+$/, '');
  const password = String(input?.adminPassword || '');
  const port = Number(input?.port || 60500);
  if (!directoryExists(moviesPath)) throw new Error('Choose an existing Movies folder.');
  if (!directoryExists(tvPath)) throw new Error('Choose an existing TV Shows folder.');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL must start with http:// or https://.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535.');
  if (!existing?.encryptedPassword && password.length < 12) throw new Error('Admin password must contain at least 12 characters.');
  if (password && password.length < 12) throw new Error('A replacement password must contain at least 12 characters.');
  return { moviesPath, tvPath, baseUrl, port, password, startAtLogin: Boolean(input?.startAtLogin) };
}

async function stopServer() {
  if (!runtime) return;
  const current = runtime;
  runtime = null;
  await current.scanner.stop();
  await current.app.close();
  current.database.close();
}

async function startServer(preferences) {
  const dataDirectory = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  let ffprobePath = require('ffprobe-static');
  if (app.isPackaged) ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');

  const environment = {
    PORT: String(preferences.port),
    HOST: '0.0.0.0',
    BASE_URL: preferences.baseUrl,
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: decryptPassword(preferences),
    SESSION_SECRET: preferences.sessionSecret,
    STREAM_SECRET: preferences.streamSecret,
    DATABASE_PATH: path.join(dataDirectory, 'media.db'),
    MOVIES_PATH: preferences.moviesPath,
    TV_PATH: preferences.tvPath,
    FFPROBE_PATH: ffprobePath,
    WATCH_MEDIA: 'true',
    SCAN_ON_STARTUP: 'true',
    LOG_LEVEL: 'info'
  };
  Object.assign(process.env, environment);

  const configUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'src', 'config.js')).href;
  const serverUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'src', 'server.js')).href;
  const [{ loadConfig }, { buildApp }] = await Promise.all([import(configUrl), import(serverUrl)]);
  const config = loadConfig(environment);
  runtime = await buildApp(config);
  await runtime.app.listen({ port: config.port, host: config.host });
  runtime.scanner.startSchedules();
  if (config.scanOnStartup) void runtime.scanner.scan('startup').catch((error) => runtime.app.log.error({ error }, 'Startup scan failed'));
}

function secureWindow(window, localOrigin) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(localOrigin)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(localOrigin)) event.preventDefault();
  });
}

function openDashboard(preferences = readPreferences()) {
  if (!preferences) return openSetup();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const localOrigin = `http://127.0.0.1:${preferences.port}`;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    title: 'Personal Media Addon',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  secureWindow(mainWindow, localOrigin);
  void mainWindow.loadURL(`${localOrigin}/admin`);
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 760,
    height: 760,
    resizable: false,
    title: 'Set up Personal Media Addon',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  void setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.on('closed', () => { setupWindow = undefined; });
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open Dashboard', accelerator: 'CmdOrCtrl+O', click: () => openDashboard() },
        { label: 'Configure Library', click: () => openSetup() },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'viewMenu' },
    { role: 'help', submenu: [{ label: 'Open health status', click: () => shell.openExternal(`http://127.0.0.1:${readPreferences()?.port || 60500}/health`) }] }
  ]));
}

ipcMain.handle('setup:choose-folder', async (_event, kind) => {
  if (kind !== 'movies' && kind !== 'tv') return null;
  const result = await dialog.showOpenDialog(setupWindow, { properties: ['openDirectory'], title: kind === 'movies' ? 'Choose Movies folder' : 'Choose TV Shows folder' });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('setup:load', () => {
  const preferences = readPreferences();
  if (!preferences) return { port: 60500, baseUrl: 'http://127.0.0.1:60500', startAtLogin: false };
  return { ...preferences, encryptedPassword: undefined, sessionSecret: undefined, streamSecret: undefined, hasPassword: Boolean(preferences.encryptedPassword) };
});

ipcMain.handle('setup:save', async (_event, input) => {
  try {
    const existing = readPreferences();
    const settings = validateSetup(input, existing);
    const preferences = {
      moviesPath: settings.moviesPath,
      tvPath: settings.tvPath,
      baseUrl: settings.baseUrl,
      port: settings.port,
      startAtLogin: settings.startAtLogin,
      encryptedPassword: settings.password ? safeStorage.encryptString(settings.password).toString('base64') : existing.encryptedPassword,
      sessionSecret: existing?.sessionSecret || crypto.randomBytes(48).toString('base64url'),
      streamSecret: existing?.streamSecret || crypto.randomBytes(48).toString('base64url')
    };
    writePreferences(preferences);
    app.setLoginItemSettings({ openAtLogin: preferences.startAtLogin });
    if (runtime) {
      await stopServer();
      app.relaunch();
      app.exit(0);
      return { ok: true, restarting: true };
    }
    await startServer(preferences);
    setupWindow?.close();
    openDashboard(preferences);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Setup could not be saved.' };
  }
});

app.on('before-quit', (event) => {
  if (quitting || !runtime) return;
  event.preventDefault();
  quitting = true;
  void stopServer().finally(() => app.exit(0));
});

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) return app.quit();
  installMenu();
  const preferences = readPreferences();
  if (!preferences) return openSetup();
  try {
    await startServer(preferences);
    openDashboard(preferences);
  } catch (error) {
    dialog.showErrorBox('Personal Media Addon could not start', error instanceof Error ? error.message : String(error));
    openSetup();
  }
});

app.on('second-instance', () => openDashboard());
app.on('window-all-closed', () => app.quit());

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

let mainWindow;
const recoverySessions = new Map();
const RECOVERY_FOLDER = '.Tuesday Recorder Recovery';

function safeFileNamePart(value, limit = 180) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, limit) || 'Recording';
}

function recordingFileName(date = new Date(), naming = {}) {
  const two = (value) => String(value).padStart(2, '0');
  const hour24 = date.getHours();
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  const mode = naming?.filenameMode === 'custom' ? 'named' : naming?.filenameMode;
  const suppliedName = safeFileNamePart(naming?.fileName || naming?.customName || 'Recording', 80);
  const values = { '{name}': suppliedName, '{MM}': two(date.getMonth() + 1), '{DD}': two(date.getDate()), '{YY}': two(date.getFullYear() % 100), '{YYYY}': String(date.getFullYear()), '{hh}': two(hour12), '{mm}': two(date.getMinutes()), '{AMPM}': suffix };
  if (mode === 'named') {
    return `${suppliedName} ${values['{MM}']}.${values['{DD}']}.${values['{YY}']}-${values['{hh}']}.${values['{mm}']}.${suffix}.mp3`;
  }
  if (mode === 'template') {
    let result = typeof naming.customFormat === 'string' && naming.customFormat.trim() ? naming.customFormat : '{name} {MM}.{DD}.{YY}-{hh}.{mm}.{AMPM}';
    for (const [token, value] of Object.entries(values)) result = result.split(token).join(value);
    return `${safeFileNamePart(result.replace(/\.mp3$/i, ''))}.mp3`;
  }
  return `Recording ${two(date.getMonth() + 1)}.${two(date.getDate())}.${two(date.getFullYear() % 100)}-${two(hour12)}.${two(date.getMinutes())}.${suffix}.mp3`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 400,
    minHeight: 500,
    backgroundColor: '#0f1117',
    title: 'Tuesday Recorder',
    icon: path.join(__dirname, 'assets', 'tuesday.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function ffmpegPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
    : path.join(__dirname, '..', 'vendor', 'ffmpeg.exe');
}

function validBitrate(value) {
  return [128, 192, 256, 320].includes(Number(value)) ? Number(value) : 320;
}

function recordingFolder(value) {
  const folder = typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : app.getPath('music');
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function availablePath(folder, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(folder, fileName);
  let number = 2;
  while (fs.existsSync(candidate)) candidate = path.join(folder, `${parsed.name} (${number++})${parsed.ext}`);
  return candidate;
}

function convertToMp3(inputPath, outputPath, bitrate) {
  const ffmpeg = ffmpegPath();
  if (!fs.existsSync(ffmpeg)) return Promise.resolve({ ok: false, error: 'The MP3 converter is missing. Extract the entire Tuesday Recorder ZIP and try again.' });
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, [
      '-y', '-i', inputPath, '-vn', '-codec:a', 'libmp3lame',
      '-b:a', `${validBitrate(bitrate)}k`, '-ar', '48000', outputPath
    ], { windowsHide: true });
    let errorText = '';
    proc.on('error', (error) => resolve({ ok: false, error: `Could not start the MP3 converter: ${error.message}` }));
    proc.stderr.on('data', (data) => { errorText = (errorText + data.toString()).slice(-4000); });
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, path: outputPath });
      else resolve({ ok: false, error: errorText.slice(-1200) });
    });
  });
}

function recoveryPaths(folder, id) {
  const safeId = String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) throw new Error('Invalid recovery recording.');
  const recoveryFolder = path.join(recordingFolder(folder), RECOVERY_FOLDER);
  return { recoveryFolder, partialPath: path.join(recoveryFolder, `${safeId}.webm.partial`), manifestPath: path.join(recoveryFolder, `${safeId}.json`) };
}

function readRecovery(folder, id) {
  const paths = recoveryPaths(folder, id);
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'));
  return { ...paths, manifest };
}

function removeRecoveryFiles(paths) {
  fs.rmSync(paths.partialPath, { force: true });
  fs.rmSync(paths.manifestPath, { force: true });
  try { fs.rmdirSync(paths.recoveryFolder); } catch {}
}

async function finalizeRecovery(folder, id) {
  const paths = readRecovery(folder, id);
  if (!fs.existsSync(paths.partialPath) || fs.statSync(paths.partialPath).size === 0) return { ok: false, error: 'The recovery checkpoint does not contain audio yet.' };
  const outputFolder = recordingFolder(folder || paths.manifest.folder);
  const outputPath = availablePath(outputFolder, safeFileNamePart(paths.manifest.targetName || 'Recovered recording.mp3'));
  const result = await convertToMp3(paths.partialPath, outputPath, paths.manifest.bitrate);
  if (result.ok) {
    removeRecoveryFiles(paths);
    recoverySessions.delete(id);
  }
  return result;
}

app.whenReady().then(() => {
  require('./playback-main')(app, ipcMain);
  ipcMain.handle('desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
      thumbnailSize: { width: 1, height: 1 }
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'system' : 'application'
    }));
  });

  ipcMain.handle('default-recording-folder', () => app.getPath('music'));

  ipcMain.handle('choose-recording-folder', async (_event, currentFolder) => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose default recording folder',
      defaultPath: currentFolder || app.getPath('music'),
      properties: ['openDirectory', 'createDirectory']
    });
    return choice.canceled || !choice.filePaths?.[0] ? { canceled: true } : { canceled: false, path: choice.filePaths[0] };
  });

  ipcMain.handle('create-recovery', (_event, options = {}) => {
    const folder = recordingFolder(options.folder);
    const recoveryFolder = path.join(folder, RECOVERY_FOLDER);
    fs.mkdirSync(recoveryFolder, { recursive: true });
    const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const paths = recoveryPaths(folder, id);
    const manifest = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      folder,
      targetName: recordingFileName(new Date(), options.naming),
      bitrate: validBitrate(options.bitrate),
      mimeType: options.mimeType || 'audio/webm'
    };
    fs.writeFileSync(paths.partialPath, Buffer.alloc(0), { flag: 'wx' });
    fs.writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    recoverySessions.set(id, { ...paths, manifest });
    return { ok: true, id, targetName: manifest.targetName };
  });

  ipcMain.handle('append-recovery', (_event, folder, id, bytes) => {
    const paths = recoverySessions.get(id) || readRecovery(folder, id);
    const handle = fs.openSync(paths.partialPath, 'a');
    try {
      fs.writeSync(handle, Buffer.from(bytes));
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    paths.manifest.updatedAt = new Date().toISOString();
    paths.manifest.bytes = fs.statSync(paths.partialPath).size;
    fs.writeFileSync(paths.manifestPath, JSON.stringify(paths.manifest, null, 2));
    recoverySessions.set(id, paths);
    return { ok: true, bytes: paths.manifest.bytes };
  });

  ipcMain.handle('finalize-recovery', (_event, folder, id) => finalizeRecovery(folder, id));

  ipcMain.handle('list-recoveries', (_event, folder) => {
    const recoveryFolder = path.join(recordingFolder(folder), RECOVERY_FOLDER);
    if (!fs.existsSync(recoveryFolder)) return [];
    return fs.readdirSync(recoveryFolder).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(recoveryFolder, name), 'utf8'));
        const partialPath = path.join(recoveryFolder, `${manifest.id}.webm.partial`);
        if (!fs.existsSync(partialPath) || fs.statSync(partialPath).size === 0) return [];
        return [{ id: manifest.id, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, targetName: manifest.targetName, bytes: fs.statSync(partialPath).size }];
      } catch { return []; }
    }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  });

  ipcMain.handle('recover-recording', (_event, folder, id) => finalizeRecovery(folder, id));
  ipcMain.handle('discard-recovery', (_event, folder, id) => {
    const paths = readRecovery(folder, id);
    removeRecoveryFiles(paths);
    recoverySessions.delete(id);
    return { ok: true };
  });

  ipcMain.handle('save-mp3', async (_event, bytes, bitrate, naming, defaultFolder) => {
    let outputPath;
    if (defaultFolder) {
      const folder = recordingFolder(defaultFolder);
      outputPath = availablePath(folder, recordingFileName(new Date(), naming));
    } else {
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: 'Save recording',
        defaultPath: path.join(app.getPath('music'), recordingFileName(new Date(), naming)),
        filters: [{ name: 'MP3 audio', extensions: ['mp3'] }]
      });
      if (choice.canceled || !choice.filePath) return { canceled: true };
      outputPath = choice.filePath;
    }

    const tempFile = path.join(os.tmpdir(), `tuesday-recorder-${Date.now()}.webm`);
    fs.writeFileSync(tempFile, Buffer.from(bytes));
    const result = await convertToMp3(tempFile, outputPath, bitrate);
    fs.rmSync(tempFile, { force: true });
    return { canceled: false, ...result };
  });

  ipcMain.handle('show-file', (_event, filePath) => shell.showItemInFolder(filePath));
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

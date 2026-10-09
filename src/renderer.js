const sources = new Map();
const PROFILE_KEY = 'tuesday-recorder.mix-profiles.v1';
const SETTINGS_KEY = 'tuesday-recorder.settings.v1';
const DEFAULT_FILE_FORMAT = '{name} {MM}.{DD}.{YY}-{hh}.{mm}.{AMPM}';
let audioContext;
let masterGain;
let mixDestination;
let masterSplitter;
let masterAnalyserLeft;
let masterAnalyserRight;
let meterSink;
let recorder;
let chunks = [];
let startedAt = 0;
let pausedAt = 0;
let pausedTotal = 0;
let timerHandle;
let meterFrame;
let renameTarget;
let checkpointTimer;
let checkpointWrite = Promise.resolve();
let recoverySessionId = null;
let recoveryChunks = [];
let activeRecordingSettings;
let activeNaming;

const $ = (id) => document.getElementById(id);

async function ensureAudio() {
  if (audioContext) return;
  audioContext = new AudioContext({ sampleRate: 48000 });
  mixDestination = audioContext.createMediaStreamDestination();
  masterGain = audioContext.createGain();
  masterSplitter = audioContext.createChannelSplitter(2);
  masterAnalyserLeft = audioContext.createAnalyser();
  masterAnalyserRight = audioContext.createAnalyser();
  meterSink = audioContext.createGain();
  meterSink.gain.value = 0;
  masterAnalyserLeft.fftSize = 256;
  masterAnalyserRight.fftSize = 256;
  masterGain.connect(mixDestination);
  masterGain.connect(masterSplitter);
  masterSplitter.connect(masterAnalyserLeft, 0);
  masterSplitter.connect(masterAnalyserRight, 1);
  masterAnalyserLeft.connect(meterSink);
  masterAnalyserRight.connect(meterSink);
  meterSink.connect(mixDestination);
  applyMasterGain();
  startMeters();
}

async function microphoneChoices() {
  await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
  return (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ id: d.deviceId, sourceId: d.deviceId, name: d.label || 'Microphone', originalName: d.label || 'Microphone', kind: 'microphone' }));
}

async function addMicrophone(choice) {
  const sourceId = choice.sourceId || choice.id;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: sourceId }, echoCancellation: false, autoGainControl: false, noiseSuppression: false } });
  await addStream({ ...choice, id: choice.id || sourceId, sourceId }, stream);
}

async function addDesktop(choice) {
  const sourceId = choice.sourceId || choice.id;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 2, maxHeight: 2, maxFrameRate: 1 } }
  });
  stream.getVideoTracks().forEach((track) => { track.stop(); stream.removeTrack(track); });
  if (!stream.getAudioTracks().length) throw new Error('Windows did not expose audio for that source. Try System audio or reopen the application and try again.');
  await addStream({ ...choice, id: choice.id || sourceId, sourceId }, stream);
}

async function addStream(choice, stream) {
  await ensureAudio();
  if (sources.has(choice.id)) { stream.getTracks().forEach((t) => t.stop()); return; }
  const input = audioContext.createMediaStreamSource(stream);
  const gain = audioContext.createGain();
  const panNode = audioContext.createStereoPanner();
  const splitter = audioContext.createChannelSplitter(2);
  const analyserLeft = audioContext.createAnalyser();
  const analyserRight = audioContext.createAnalyser();
  analyserLeft.fftSize = 256;
  analyserRight.fftSize = 256;
  input.connect(gain); gain.connect(panNode); panNode.connect(masterGain); panNode.connect(splitter);
  splitter.connect(analyserLeft, 0); splitter.connect(analyserRight, 1);
  analyserLeft.connect(meterSink); analyserRight.connect(meterSink);
  const model = {
    ...choice,
    originalName: choice.originalName || choice.name,
    sourceId: choice.sourceId || choice.id,
    stream, input, gain, panNode, splitter, analyserLeft, analyserRight,
    volume: Number.isFinite(Number(choice.volume)) ? Math.max(0, Math.min(300, Number(choice.volume))) : 100,
    pan: Number.isFinite(Number(choice.pan)) ? Math.max(-100, Math.min(100, Number(choice.pan))) : 0,
    muted: Boolean(choice.muted)
  };
  sources.set(model.id, model);
  applyGain(model); applyPan(model);
  renderStrip(model);
  $('emptyState').hidden = true;
  updateRecordAvailability();
  return model;
}

function sourceKindName(kind) { return kind === 'microphone' ? 'Microphone' : kind === 'playback' ? 'Playback device' : kind === 'system' ? 'Computer audio' : 'Application audio'; }
function sourceIcon(kind) { return kind === 'microphone' ? '🎙' : kind === 'playback' ? '🔈' : kind === 'system' ? '🖥' : '◉'; }
function panLabel(value) { return value === 0 ? 'Center' : `${Math.abs(value)}% ${value < 0 ? 'L' : 'R'}`; }

function renderStrip(model) {
  const strip = $('stripTemplate').content.firstElementChild.cloneNode(true);
  strip.dataset.id = model.id;
  strip.querySelector('.source-icon').textContent = sourceIcon(model.kind);
  strip.querySelector('.source-name').textContent = model.name;
  strip.querySelector('.source-kind').textContent = sourceKindName(model.kind);
  const slider = strip.querySelector('.volume');
  const value = strip.querySelector('.volume-value');
  slider.value = model.volume; value.textContent = `${model.volume}%`;
  slider.addEventListener('input', () => { model.volume = Number(slider.value); value.textContent = `${model.volume}%`; applyGain(model); });
  const pan = strip.querySelector('.pan'); const panValue = strip.querySelector('.pan-value');
  pan.value = model.pan; panValue.textContent = panLabel(model.pan);
  pan.addEventListener('input', () => { model.pan = Number(pan.value); panValue.textContent = panLabel(model.pan); applyPan(model); });
  const mute = strip.querySelector('.mute'); mute.textContent = model.muted ? '🔇' : '🔊'; strip.classList.toggle('muted', model.muted);
  mute.addEventListener('click', () => { model.muted = !model.muted; mute.textContent = model.muted ? '🔇' : '🔊'; strip.classList.toggle('muted', model.muted); applyGain(model); });
  strip.querySelector('.edit').addEventListener('click', () => openRename(model));
  strip.querySelector('.remove').addEventListener('click', () => removeSource(model.id));
  $('sourceList').appendChild(strip);
}

function applyGain(model) { model.gain.gain.setTargetAtTime(model.muted ? 0 : model.volume / 100, audioContext.currentTime, 0.01); }
function applyPan(model) { model.panNode.pan.setTargetAtTime(model.pan / 100, audioContext.currentTime, 0.01); }
function applyMasterGain() { if (masterGain) masterGain.gain.setTargetAtTime($('masterMute').dataset.muted === 'true' ? 0 : Number($('masterVolume').value) / 100, audioContext.currentTime, 0.01); }

function removeSource(id) {
  const model = sources.get(id); if (!model) return;
  sources.delete(id); if (model.onRemove) model.onRemove();
  model.stream.getTracks().forEach((t) => t.stop()); model.input.disconnect(); model.gain.disconnect(); model.panNode.disconnect(); model.splitter.disconnect(); model.analyserLeft.disconnect(); model.analyserRight.disconnect();
  document.querySelector(`.strip[data-id="${CSS.escape(id)}"]`)?.remove();
  $('emptyState').hidden = sources.size > 0; updateRecordAvailability();
}

function openRename(model) { renameTarget = model; $('renameInput').value = model.name; $('renameDialog').showModal(); $('renameInput').focus(); $('renameInput').select(); }

function showPicker(title, choices, add) {
  $('pickerTitle').textContent = title; $('pickerList').replaceChildren();
  choices.forEach((choice) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'pick'; button.innerHTML = `<strong></strong><small></small>`; button.querySelector('strong').textContent = choice.name; button.querySelector('small').textContent = sourceKindName(choice.kind); button.onclick = async () => { $('picker').close(); await safely(() => add(choice)); }; $('pickerList').appendChild(button); });
  $('picker').showModal();
}

async function safely(action) { try { await action(); if (!recorder || recorder.state === 'inactive') setMessage('Ready'); } catch (error) { setMessage(error.message, true); } }
function setMessage(text, error = false) { $('message').textContent = text; $('message').style.color = error ? '#ff829c' : ''; }
function updateRecordAvailability() { $('record').disabled = sources.size === 0 || recorder?.state === 'recording'; }

function startMeters() {
  const data = new Uint8Array(128);
  const paint = (analyser, element) => { analyser.getByteTimeDomainData(data); let sum = 0; for (const value of data) { const n = (value - 128) / 128; sum += n * n; } const rms = Math.sqrt(sum / data.length); element.style.width = `${Math.min(100, rms * 330)}%`; };
  const loop = () => {
    for (const [id, model] of sources) {
      const strip = document.querySelector(`.strip[data-id="${CSS.escape(id)}"]`);
      if (strip) { paint(model.analyserLeft, strip.querySelector('.meter-left')); paint(model.analyserRight, strip.querySelector('.meter-right')); }
    }
    paint(masterAnalyserLeft, $('masterMeterLeft')); paint(masterAnalyserRight, $('masterMeterRight'));
    meterFrame = requestAnimationFrame(loop);
  };
  loop();
}

async function startRecording() {
  const settings = await ensureDefaultRecordingFolder();
  if (settingsNeedsName(settings) && !$('quickFileName').value.trim()) { $('quickFileName').focus(); throw new Error('Enter a file name before recording.'); }
  await ensureAudio(); await audioContext.resume(); chunks = [];
  recoveryChunks = []; recoverySessionId = null; checkpointWrite = Promise.resolve(); activeRecordingSettings = settings; activeNaming = namingForSave();
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
  recorder = new MediaRecorder(mixDestination.stream, mimeType ? { mimeType, audioBitsPerSecond: 320000 } : undefined);
  if (settings.autoSaveEnabled) {
    const recovery = await window.tuesday.createRecovery({ folder: settings.defaultRecordingFolder, naming: activeNaming, bitrate: Number($('bitrate').value), mimeType: recorder.mimeType });
    if (!recovery.ok) throw new Error(recovery.error || 'Could not create the recovery checkpoint.');
    recoverySessionId = recovery.id;
  }
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    if (recoverySessionId) recoveryChunks.push(event.data);
    else chunks.push(event.data);
  };
  recorder.onstop = saveRecording;
  recorder.start(1000); startedAt = Date.now(); pausedTotal = 0; pausedAt = 0; timerHandle = setInterval(updateTimer, 250);
  if (recoverySessionId) checkpointTimer = setInterval(() => flushRecoveryCheckpoint().catch((error) => setMessage(`Recovery checkpoint could not be saved: ${error.message}`, true)), settings.autoSaveSeconds * 1000);
  $('quickFileName').disabled = true; $('record').disabled = true; $('pause').disabled = false; $('stop').disabled = false; setStatus('Recording', true); setMessage(recoverySessionId ? `Recording all active mixer sources… Recovery saves every ${settings.autoSaveSeconds} seconds.` : 'Recording all active mixer sources…');
}

function flushRecoveryCheckpoint() {
  if (!recoverySessionId) return checkpointWrite;
  const task = checkpointWrite.then(async () => {
    if (!recoveryChunks.length) return;
    const batch = recoveryChunks; recoveryChunks = [];
    try {
      const blob = new Blob(batch, { type: recorder?.mimeType || 'audio/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await window.tuesday.appendRecovery(activeRecordingSettings.defaultRecordingFolder, recoverySessionId, bytes);
      if (!result.ok) throw new Error(result.error || 'The checkpoint could not be written.');
    } catch (error) {
      recoveryChunks = batch.concat(recoveryChunks);
      throw error;
    }
  });
  checkpointWrite = task.catch(() => {});
  return task;
}

function togglePause() {
  if (recorder.state === 'recording') { recorder.pause(); pausedAt = Date.now(); $('pause').textContent = '▶ Resume'; setStatus('Paused'); }
  else { recorder.resume(); pausedTotal += Date.now() - pausedAt; pausedAt = 0; $('pause').textContent = 'Ⅱ Pause'; setStatus('Recording', true); }
}

function stopRecording() { if (recorder?.state === 'paused') { pausedTotal += Date.now() - pausedAt; } clearInterval(checkpointTimer); checkpointTimer = null; recorder.stop(); clearInterval(timerHandle); $('pause').disabled = true; $('stop').disabled = true; setStatus('Creating MP3'); setMessage('Converting and saving your MP3…'); }

async function saveRecording() {
  try {
    let result;
    if (recoverySessionId) {
      await flushRecoveryCheckpoint();
      result = await window.tuesday.finalizeRecovery(activeRecordingSettings.defaultRecordingFolder, recoverySessionId);
    } else {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      result = await window.tuesday.saveMp3(bytes, Number($('bitrate').value), activeNaming, activeRecordingSettings.defaultRecordingFolder);
    }
    if (result.canceled) setMessage('Recording was not saved.', true);
    else if (!result.ok) throw new Error(`MP3 conversion failed. ${result.error}${recoverySessionId ? ' Your recovery checkpoint was kept.' : ''}`);
    else { setMessage(`Saved: ${result.path}`); $('message').onclick = () => window.tuesday.showFile(result.path); }
  }
  catch (error) { setMessage(error.message, true); }
  finally { setStatus('Ready'); $('record').disabled = sources.size === 0; $('quickFileName').disabled = false; $('timer').textContent = '00:00:00'; recorder = null; recoverySessionId = null; recoveryChunks = []; activeRecordingSettings = null; activeNaming = null; }
}

function updateTimer() { const now = pausedAt || Date.now(); const total = Math.max(0, now - startedAt - pausedTotal); const seconds = Math.floor(total / 1000); $('timer').textContent = [Math.floor(seconds/3600), Math.floor(seconds/60)%60, seconds%60].map((n)=>String(n).padStart(2,'0')).join(':'); }
function setStatus(text, recording = false) { $('statusText').textContent = text; $('statusDot').style.background = recording ? '#ef5473' : '#48d597'; $('statusDot').style.boxShadow = `0 0 9px ${recording ? '#ef5473' : '#48d597'}`; }

function readSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const filenameMode = parsed.filenameMode === 'custom' ? 'named' : ['standard', 'named', 'template'].includes(parsed.filenameMode) ? parsed.filenameMode : 'standard';
    const seconds = Number(parsed.autoSaveSeconds);
    return {
      filenameMode,
      customFormat: typeof parsed.customFormat === 'string' && parsed.customFormat.trim() ? parsed.customFormat : DEFAULT_FILE_FORMAT,
      legacyName: typeof parsed.customName === 'string' ? parsed.customName : '',
      defaultRecordingFolder: typeof parsed.defaultRecordingFolder === 'string' ? parsed.defaultRecordingFolder : '',
      autoSaveEnabled: parsed.autoSaveEnabled != false,
      autoSaveSeconds: Number.isFinite(seconds) ? Math.max(5, Math.min(3600, Math.round(seconds / 5) * 5)) : 10
    };
  } catch { return { filenameMode: 'standard', customFormat: DEFAULT_FILE_FORMAT, legacyName: '', defaultRecordingFolder: '', autoSaveEnabled: true , autoSaveSeconds: 10 }; }
}

async function ensureDefaultRecordingFolder() {
  const settings = readSettings();
  if (!settings.defaultRecordingFolder) {
    settings.defaultRecordingFolder = await window.tuesday.defaultRecordingFolder();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  return settings;
}

function cleanPreviewName(value) { return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '') || 'Recording'; }
function previewFileName(settings, date = new Date(), suppliedName = 'Name') {
  const two = (value) => String(value).padStart(2, '0');
  const hour24 = date.getHours(); const suffix = hour24 >= 12 ? 'PM' : 'AM'; const hour12 = hour24 % 12 || 12;
  const values = { '{name}': cleanPreviewName(suppliedName || 'Name'), '{MM}': two(date.getMonth() + 1), '{DD}': two(date.getDate()), '{YY}': two(date.getFullYear() % 100), '{YYYY}': String(date.getFullYear()), '{hh}': two(hour12), '{mm}': two(date.getMinutes()), '{AMPM}': suffix };
  if (settings.filenameMode === 'named') return `${values['{name}']} ${values['{MM}']}.${values['{DD}']}.${values['{YY}']}-${values['{hh}']}.${values['{mm}']}.${values['{AMPM}']}.mp3`;
  if (settings.filenameMode === 'template') {
    let result = settings.customFormat || DEFAULT_FILE_FORMAT;
    for (const [token, value] of Object.entries(values)) result = result.split(token).join(value);
    return `${cleanPreviewName(result.replace(/\.mp3$/i, '')).slice(0, 180)}.mp3`;
  }
  return `Recording ${two(date.getMonth() + 1)}.${two(date.getDate())}.${two(date.getFullYear() % 100)}-${two(hour12)}.${two(date.getMinutes())}.${suffix}.mp3`;
}

function settingsNeedsName(settings) { return settings.filenameMode === 'named' || (settings.filenameMode === 'template' && settings.customFormat.includes('{name}')); }
function namingForSave() { const settings = readSettings(); return { filenameMode: settings.filenameMode, customFormat: settings.customFormat, fileName: $('quickFileName').value.trim() }; }
function refreshQuickNameUI() {
  const settings = readSettings(); const needed = settingsNeedsName(settings); const name = $('quickFileName').value.trim() || 'Name';
  $('quickNameRow').hidden = !needed;
  $('quickNamePreview').textContent = needed ? `Next file: ${previewFileName(settings, new Date(), name)}` : '';
}
function settingsFromDialog() {
  const selected = document.querySelector('input[name="fileNamingMode"]:checked')?.value;
  const seconds = Number($('autoSaveSeconds').value);
  return {
    filenameMode: ['standard', 'named', 'template'].includes(selected) ? selected : 'standard',
    customFormat: $('customFormat').value.trim(),
    defaultRecordingFolder: $('defaultRecordingFolder').value.trim(),
    autoSaveEnabled: $('autoSaveEnabled').checked,
    autoSaveSeconds: Number.isFinite(seconds) ? Math.max(5, Math.min(3600, Math.round(seconds / 5) * 5)) : 10
  };
}
function updateSettingsPreview() {
  const settings = settingsFromDialog(); const custom = settings.filenameMode === 'template';
  $('customFormat').disabled = !custom; $('customFormat').closest('.format-field').classList.toggle('disabled', !custom);
  $('autoSaveSeconds').disabled = !settings.autoSaveEnabled; $('autoSaveSeconds').closest('.interval-field').classList.toggle('disabled', !settings.autoSaveEnabled);
  $('filenamePreview').textContent = previewFileName(settings, new Date(), $('quickFileName').value.trim() || 'Name');
}
function populateSettingsProfiles() {
  const store = readProfiles(); const names = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  $('settingsDefaultProfile').replaceChildren(new Option('Do not load a profile', ''));
  names.forEach((name) => $('settingsDefaultProfile').add(new Option(name, name)));
  $('settingsDefaultProfile').value = names.includes(store.defaultProfile) ? store.defaultProfile : '';
}
async function openSettings() {
  const settings = await ensureDefaultRecordingFolder();
  document.querySelector(`input[name="fileNamingMode"][value="${settings.filenameMode}"]`).checked = true;
  $('customFormat').value = settings.customFormat; $('defaultRecordingFolder').value = settings.defaultRecordingFolder; $('autoSaveEnabled').checked = settings.autoSaveEnabled; $('autoSaveSeconds').value = settings.autoSaveSeconds;
  populateSettingsProfiles(); $('settingsMessage').textContent = ''; updateSettingsPreview(); $('settingsDialog').showModal();
}

function readProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return { profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {}, defaultProfile: parsed.defaultProfile || null };
  } catch { return { profiles: {}, defaultProfile: null }; }
}

function writeProfiles(store) { localStorage.setItem(PROFILE_KEY, JSON.stringify(store)); }

function profileSource(model) {
  return { id: model.id, sourceId: model.sourceId, name: model.name, originalName: model.originalName, kind: model.kind, volume: model.volume, pan: model.pan, muted: model.muted };
}

function currentProfile(name) {
  return {
    name,
    sources: [...sources.values()].map(profileSource),
    masterVolume: Number($('masterVolume').value),
    masterMuted: $('masterMute').dataset.muted === 'true',
    bitrate: Number($('bitrate').value)
  };
}

function updateDefaultCheckbox() {
  const selected = $('profileSelect').value;
  const store = readProfiles();
  $('defaultProfile').checked = Boolean(selected && store.defaultProfile === selected);
  $('defaultProfile').disabled = !selected;
  $('loadProfile').disabled = !selected;
  $('deleteProfile').disabled = !selected;
}

function refreshProfileList(selectedName) {
  const store = readProfiles();
  const names = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  $('profileSelect').replaceChildren();
  if (!names.length) {
    const option = new Option('No profiles saved yet', ''); option.disabled = true; option.selected = true; $('profileSelect').add(option);
  } else {
    names.forEach((name) => $('profileSelect').add(new Option(name, name)));
    $('profileSelect').value = names.includes(selectedName) ? selectedName : names.includes(store.defaultProfile) ? store.defaultProfile : names[0];
  }
  updateDefaultCheckbox();
}

function profileMessage(text, error = false) { $('profileMessage').textContent = text; $('profileMessage').style.color = error ? '#ff829c' : ''; }

function saveCurrentProfile() {
  const name = $('profileName').value.trim();
  if (!name) { profileMessage('Enter a profile name first.', true); $('profileName').focus(); return; }
  const store = readProfiles();
  store.profiles[name] = currentProfile(name);
  writeProfiles(store); refreshProfileList(name); $('profileName').value = ''; profileMessage(`Saved “${name}”.`);
}

async function findSavedSource(saved) {
  let choices;
  if (saved.kind === 'microphone') choices = await microphoneChoices();
  else if (saved.kind === 'playback') choices = await window.tuesday.playbackDevices();
  else choices = (await window.tuesday.getDesktopSources()).filter((choice) => choice.kind === saved.kind);
  return choices.find((choice) => choice.id === saved.sourceId || choice.id === saved.id) || choices.find((choice) => choice.name === saved.originalName);
}

async function restoreSource(saved) {
  const found = await findSavedSource(saved);
  if (!found) throw new Error(saved.originalName || saved.name);
  const configured = {
    ...found,
    id: saved.kind === 'playback' ? `playback:${found.id}` : found.id,
    sourceId: found.id,
    originalName: found.name,
    name: saved.name,
    kind: saved.kind,
    volume: saved.volume,
    pan: saved.pan,
    muted: saved.muted
  };
  if (saved.kind === 'microphone') await addMicrophone(configured);
  else if (saved.kind === 'playback') await addPlayback(found, configured);
  else await addDesktop(configured);
}

async function loadProfileByName(name, automatic = false) {
  const profile = readProfiles().profiles[name];
  if (!profile) throw new Error(`The mix profile “${name}” was not found.`);
  for (const id of [...sources.keys()]) removeSource(id);
  $('masterVolume').value = Math.max(0, Math.min(300, Number(profile.masterVolume) || 100));
  $('masterValue').textContent = `${$('masterVolume').value}%`;
  $('masterMute').dataset.muted = String(Boolean(profile.masterMuted));
  $('masterMute').textContent = profile.masterMuted ? '🔇' : '🔊';
  $('bitrate').value = ['128', '192', '256', '320'].includes(String(profile.bitrate)) ? String(profile.bitrate) : '320';
  applyMasterGain();
  const missing = [];
  for (const saved of profile.sources || []) {
    try { await restoreSource(saved); } catch { missing.push(saved.name || saved.originalName || 'Unknown source'); }
  }
  const summary = missing.length ? `Loaded “${name}”, but could not find: ${missing.join(', ')}.` : `Loaded “${name}”.`;
  if (automatic) setMessage(summary, missing.length > 0); else profileMessage(summary, missing.length > 0);
}

async function loadDefaultProfile() {
  const store = readProfiles();
  if (!store.defaultProfile || !store.profiles[store.defaultProfile]) return;
  try { await loadProfileByName(store.defaultProfile, true); }
  catch (error) { setMessage(`Default profile could not load: ${error.message}`, true); }
}

function recoverySize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function checkForRecoveries() {
  try {
    const settings = await ensureDefaultRecordingFolder();
    const recoveries = await window.tuesday.listRecoveries(settings.defaultRecordingFolder);
    if (!recoveries.length) return;
    $('recoveryList').replaceChildren();
    recoveries.forEach((item) => {
      const row = document.createElement('div'); row.className = 'recovery-item';
      const details = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = item.targetName || 'Recovered recording.mp3';
      const meta = document.createElement('small'); meta.textContent = `${new Date(item.createdAt).toLocaleString()} · ${recoverySize(item.bytes)}`;
      details.append(title, meta);
      const actions = document.createElement('div'); actions.className = 'recovery-actions';
      const recover = document.createElement('button'); recover.type = 'button'; recover.textContent = 'Recover MP3';
      const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'secondary'; discard.textContent = 'Discard';
      recover.onclick = async () => {
        recover.disabled = true; discard.disabled = true; $('recoveryMessage').textContent = 'Recovering and converting the recording…';
        try {
          const result = await window.tuesday.recoverRecording(settings.defaultRecordingFolder, item.id);
          if (!result.ok) throw new Error(result.error || 'The recording could not be recovered.');
          row.remove(); $('recoveryMessage').textContent = `Recovered: ${result.path}`; setMessage(`Recovered: ${result.path}`); $('message').onclick = () => window.tuesday.showFile(result.path);
          if (!$('recoveryList').children.length) setTimeout(() => $('recoveryDialog').close(), 700);
        } catch (error) { recover.disabled = false; discard.disabled = false; $('recoveryMessage').textContent = error.message; $('recoveryMessage').style.color = '#ff829c'; }
      };
      discard.onclick = async () => {
        if (!window.confirm('Discard this recovery checkpoint? The unfinished audio cannot be restored afterward.')) return;
        discard.disabled = true;
        try { await window.tuesday.discardRecovery(settings.defaultRecordingFolder, item.id); row.remove(); if (!$('recoveryList').children.length) $('recoveryDialog').close(); }
        catch (error) { discard.disabled = false; $('recoveryMessage').textContent = error.message; $('recoveryMessage').style.color = '#ff829c'; }
      };
      actions.append(recover, discard); row.append(details, actions); $('recoveryList').append(row);
    });
    $('recoveryMessage').textContent = ''; $('recoveryMessage').style.color = ''; $('recoveryDialog').showModal();
  } catch (error) { setMessage(`Could not check recovery recordings: ${error.message}`, true); }
}

$('addMic').onclick = () => safely(async () => showPicker('Choose a microphone', await microphoneChoices(), addMicrophone));
$('addSystem').onclick = () => safely(async () => showPicker('Choose computer audio', (await window.tuesday.getDesktopSources()).filter((s) => s.kind === 'system'), addDesktop));
$('addApp').onclick = () => safely(async () => showPicker('Choose an application', (await window.tuesday.getDesktopSources()).filter((s) => s.kind === 'application'), addDesktop));
$('masterVolume').oninput = (event) => { $('masterValue').textContent = `${event.target.value}%`; applyMasterGain(); };
$('masterMute').onclick = (event) => { const muted = event.currentTarget.dataset.muted !== 'true'; event.currentTarget.dataset.muted = String(muted); event.currentTarget.textContent = muted ? '🔇' : '🔊'; applyMasterGain(); };
$('renameForm').onsubmit = (event) => { event.preventDefault(); if (event.submitter?.value === 'cancel') { $('renameDialog').close(); renameTarget = null; return; } const name = $('renameInput').value.trim(); if (!renameTarget || !name) return; renameTarget.name = name; document.querySelector(`.strip[data-id="${CSS.escape(renameTarget.id)}"] .source-name`).textContent = name; $('renameDialog').close(); renameTarget = null; };
$('profilesButton').onclick = () => { profileMessage(''); refreshProfileList(); $('profilesDialog').showModal(); };
$('settingsButton').onclick = () => safely(openSettings);
$('settingsForm').onchange = updateSettingsPreview;
$('customFormat').oninput = updateSettingsPreview;
$('quickFileName').oninput = refreshQuickNameUI;
$('browseRecordingFolder').onclick = async () => {
  const result = await window.tuesday.chooseRecordingFolder($('defaultRecordingFolder').value);
  if (!result.canceled) $('defaultRecordingFolder').value = result.path;
};
document.querySelectorAll('[data-token]').forEach((button) => { button.onclick = () => { const input = $('customFormat'); document.querySelector('input[name="fileNamingMode"][value="template"]').checked = true; input.disabled = false; const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start; input.setRangeText(button.dataset.token, start, end, 'end'); input.focus(); updateSettingsPreview(); }; });
$('settingsForm').onsubmit = (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('settingsDialog').close(); return; }
  const settings = settingsFromDialog();
  if (settings.filenameMode === 'template' && !settings.customFormat) { $('settingsMessage').textContent = 'Enter a filename format or use the field buttons.'; $('settingsMessage').style.color = '#ff829c'; $('customFormat').focus(); return; }
  if (!settings.defaultRecordingFolder) { $('settingsMessage').textContent = 'Choose a default recording folder.'; $('settingsMessage').style.color = '#ff829c'; $('defaultRecordingFolder').focus(); return; }
  if (!settings.customFormat) settings.customFormat = DEFAULT_FILE_FORMAT;
  $('autoSaveSeconds').value = settings.autoSaveSeconds;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  const store = readProfiles(); store.defaultProfile = $('settingsDefaultProfile').value || null; writeProfiles(store);
  $('settingsDialog').close(); refreshQuickNameUI(); setMessage(`Settings saved. Next file: ${previewFileName(settings, new Date(), $('quickFileName').value.trim() || 'Name')}`);
};
$('profileSelect').onchange = updateDefaultCheckbox;
$('saveProfile').onclick = saveCurrentProfile;
$('loadProfile').onclick = () => safely(() => loadProfileByName($('profileSelect').value));
$('deleteProfile').onclick = () => { const name = $('profileSelect').value; if (!name) return; const store = readProfiles(); delete store.profiles[name]; if (store.defaultProfile === name) store.defaultProfile = null; writeProfiles(store); refreshProfileList(); profileMessage(`Deleted “${name}”.`); };
$('defaultProfile').onchange = () => { const store = readProfiles(); store.defaultProfile = $('defaultProfile').checked ? $('profileSelect').value : null; writeProfiles(store); profileMessage($('defaultProfile').checked ? `“${store.defaultProfile}” will load at startup.` : 'Automatic profile loading is off.'); };
$('record').onclick = () => safely(startRecording); $('pause').onclick = togglePause; $('stop').onclick = stopRecording;
window.addEventListener('beforeunload', () => { cancelAnimationFrame(meterFrame); for (const id of [...sources.keys()]) removeSource(id); });
const initialSettings = readSettings(); if (initialSettings.legacyName) $('quickFileName').value = initialSettings.legacyName; refreshQuickNameUI();
setTimeout(loadDefaultProfile, 0);
setTimeout(checkForRecoveries, 200);

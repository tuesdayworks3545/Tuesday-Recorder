const {spawn, spawnSync} = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
module.exports = function(app, ipcMain) {
  const running = new Map();
  const bundled = () => app.isPackaged ? path.join(process.resourcesPath,'bin') : path.join(__dirname,'..','vendor');
  // Keep each release in its own helper folder. Windows locks a running
  // executable, so overwriting one from an earlier release can fail with CS0016.
  const compiled = () => path.join(app.getPath('userData'),'native',app.getVersion(),'TuesdayPlayback.exe');
  function ensureHelper() {
    const output=compiled(), outputDir=path.dirname(output), sourceDir=bundled();
    if(fs.existsSync(output) && (app.isPackaged || fs.statSync(output).mtimeMs >= Math.max(fs.statSync(path.join(sourceDir,'Program.cs')).mtimeMs,fs.statSync(path.join(sourceDir,'PlaybackCapture.cs')).mtimeMs))) return output;
    fs.mkdirSync(outputDir,{recursive:true});
    const windows=process.env.WINDIR || 'C:\\Windows';
    const candidates=[path.join(windows,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),path.join(windows,'Microsoft.NET','Framework','v4.0.30319','csc.exe')];
    const csc=candidates.find(fs.existsSync);
    if(!csc) throw new Error('The Windows .NET Framework compiler was not found. Enable .NET Framework 4.8 in Windows Features and try again.');
    const naudio=path.join(sourceDir,'NAudio.dll');
    const result=spawnSync(csc,['/nologo','/target:exe','/platform:x64',`/out:${output}`,`/reference:${naudio}`,'/reference:System.Web.Extensions.dll',path.join(sourceDir,'Program.cs'),path.join(sourceDir,'PlaybackCapture.cs')],{windowsHide:true,encoding:'utf8'});
    if(result.error || result.status!==0 || !fs.existsSync(output)) throw new Error(`Playback helper could not be prepared: ${result.error?.message || result.stderr || result.stdout || 'compiler failed'}`);
    fs.copyFileSync(naudio,path.join(outputDir,'NAudio.dll'));
    return output;
  }
  function launch(mode, id) {
    const args=[mode];
    if(id) args.push(id);
    return spawn(ensureHelper(),args,{windowsHide:true});
  }
  ipcMain.handle('playback-list', () => new Promise((resolve,reject) => {
    const child=launch('list'); let out='',err='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Playback-device discovery timed out.'));},15000);
    child.stdout.on('data',b=>out+=b); child.stderr.on('data',b=>err=(err+b).slice(-3000));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error(err || 'Cannot list playback devices.'));try{resolve(JSON.parse(out.trim()||'[]'));}catch(e){reject(e);}});
  }));
  ipcMain.handle('playback-start',(event,id)=>new Promise((resolve,reject)=>{
    if(typeof id!=='string'||id.length>1024)return reject(new Error('Invalid device.'));
    if(running.has(id))return reject(new Error('Device already added.'));
    const child=launch('capture',id); running.set(id,child); let ready=false,err='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Playback capture could not start.'));},15000);
    const lines=readline.createInterface({input:child.stdout});
    lines.on('line',line=>{try{const packet=JSON.parse(line);if(packet.ready){ready=true;clearTimeout(timer);resolve(true);}else if(!event.sender.isDestroyed())event.sender.send('playback-data',{id,...packet});}catch{}});
    child.stderr.on('data',b=>err=(err+b).slice(-3000));
    child.on('error',e=>{clearTimeout(timer);running.delete(id);reject(e);});
    child.on('close',()=>{clearTimeout(timer);const unexpected=running.get(id)===child;running.delete(id);if(!ready)reject(new Error(err||'Playback capture failed.'));else if(unexpected&&!event.sender.isDestroyed())event.sender.send('playback-data',{id,error:err||'Playback device disconnected.'});});
  }));
  ipcMain.handle('playback-stop',(_event,id)=>{const child=running.get(id);running.delete(id);if(child)child.kill();});
  app.on('before-quit',()=>{for(const child of running.values())child.kill();running.clear();});
};

const playbackNodes = new Map();
async function refreshPlayback() {
  const list=$('playbackDevices'); list.textContent='Finding playback devices…';
  try {
    const devices=await window.tuesday.playbackDevices(); list.replaceChildren();
    if(!devices.length)list.textContent='No active playback devices found. Connect speakers or headphones and refresh.';
    for(const device of devices){const button=document.createElement('button');button.className='pick';button.textContent='＋ '+device.name;button.onclick=()=>safely(()=>addPlayback(device));list.appendChild(button);}
  } catch(error){list.textContent=error.message;}
}
async function addPlayback(device, settings={}) {
  if(playbackNodes.has(device.id))return;
  await ensureAudio(); await audioContext.resume();
  const destination=audioContext.createMediaStreamDestination();
  const state={destination,next:0,pending:new Set()};playbackNodes.set(device.id,state);
  try {
    await window.tuesday.startPlayback(device.id);
    await addStream({...settings,id:'playback:'+device.id,sourceId:device.id,name:settings.name||device.name,originalName:device.name,kind:'playback',onRemove:()=>stopPlayback(device.id)},destination.stream);
  }catch(error){stopPlayback(device.id);throw error;}
}
function stopPlayback(id){const state=playbackNodes.get(id);playbackNodes.delete(id);if(state){for(const node of state.pending){node.stop();node.disconnect();}state.destination.disconnect();}window.tuesday.stopPlayback(id);}
window.tuesday.onPlayback(packet=>{
  const state=playbackNodes.get(packet.id);if(!state)return;
  if(packet.error){setMessage(packet.error,true);removeSource('playback:'+packet.id);stopPlayback(packet.id);return;}
  const raw=Uint8Array.from(atob(packet.pcm),c=>c.charCodeAt(0));
  const samples=new Float32Array(raw.buffer);const frames=samples.length/packet.channels;
  if(!Number.isInteger(frames)||!frames)return;
  const buffer=audioContext.createBuffer(packet.channels,frames,packet.rate);
  for(let c=0;c<packet.channels;c++){const channel=buffer.getChannelData(c);for(let f=0;f<frames;f++)channel[f]=samples[f*packet.channels+c];}
  // Bound latency after a busy renderer; never queue an unlimited audio backlog.
  if(state.next>audioContext.currentTime+.5)return;
  state.next=Math.max(state.next,audioContext.currentTime+.04);
  const node=audioContext.createBufferSource();node.buffer=buffer;node.connect(state.destination);state.pending.add(node);
  node.onended=()=>{state.pending.delete(node);node.disconnect();};node.start(state.next);state.next+=buffer.duration;
});
$('playbackTab').onclick=()=>{const panel=$('playbackPanel');panel.hidden=!panel.hidden;$('playbackTab').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)refreshPlayback();};
$('refreshPlayback').onclick=refreshPlayback;
window.addEventListener('beforeunload',()=>{for(const id of playbackNodes.keys())stopPlayback(id);});

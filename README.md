# Tuesday Recorder 1.1

Tuesday Recorder is a portable Windows audio recorder with multi-source mixing and MP3 output.

## Features

- Record microphones, playback devices, system audio, and individual applications.
- Name a recording before it is saved, or customize the filename format.
- Adjust the volume and left/right pan for every source in the audio mixer.
- Control the finished mix with a master volume slider and mute button.
- Save mix profiles containing sources, names, levels, pan, MP3 quality, and master level.
- Write recovery checkpoints every 10 seconds by default while recording.
- Recover unfinished audio after Tuesday Recorder or Windows closes unexpectedly.
- Choose the default recordings folder and MP3 quality.
- Resize to narrow Windows layouts, including approximately one-third of a widescreen display.

## Download

The ready-to-use Windows portable build is published on the repository's **Releases** page. Download the ZIP, extract the entire folder, and run `Tuesday Recorder 1.1.exe`.

The full folder must be extracted because the app includes an MP3 converter and supporting files.

## Run from source

1. Install a current Node.js release on Windows.
2. Run `npm install`.
3. Run `npm start`.

## Build the portable Windows app

Run:

```powershell
npm install
npm run build
```

The portable build is created in `dist`.

## Recording recovery

Recovery checkpoints are stored in a hidden `.Tuesday Recorder Recovery` folder inside the selected recordings folder. A normal stop converts the recording to MP3 and removes its temporary checkpoint. If the app closes unexpectedly, the next launch offers to recover the unfinished recording.

## Privacy

Tuesday Recorder runs locally. Recording files and recovery checkpoints stay in the folder selected by the user.

## License

Copyright Tuesday Works. All rights reserved. No license is granted for reuse or redistribution of the source code unless the copyright owner gives written permission.

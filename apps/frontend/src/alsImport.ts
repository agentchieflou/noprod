// Ableton Live Set (.als) import: its tempo, tracks (name, colour, mixer,
// plug-in names) and arrangement MIDI clips, with their notes. Loaded when
// a set is opened.

import { createDefaultInstrument } from './store/useDAWStore';

export async function parseAbletonSet(file: File, returns: any[], colors: string[]) {
  // Decompress using modern native browser DecompressionStream (GZIP)
  const decompressedStream = file.stream().pipeThrough(new DecompressionStream('gzip'));
  const response = new Response(decompressedStream);
  const xmlText = await response.text();

  // Parse decompressed XML text
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

  // Validate Ableton XML root node
  const abletonNode = xmlDoc.querySelector('Ableton');
  if (!abletonNode) return null;

  // 1. Extract BPM/Tempo
  const tempoNode = xmlDoc.querySelector('Tempo Manual Value, Tempo Manual');
  const tempo = tempoNode ? parseFloat(tempoNode.getAttribute('Value') || '120') : 120;

  // 2. Extract Tracks & Placed clips
  const tracksList: any[] = [];
  const regionsList: any[] = [];
  let skippedAudioClips = 0;

  // Query both audio and midi tracks
  const trackNodes = xmlDoc.querySelectorAll('Tracks AudioTrack, Tracks MidiTrack');
  trackNodes.forEach((trackNode, index) => {
    const type = trackNode.nodeName === 'AudioTrack' ? 'audio' : 'midi';
    const id = `als-track-${index}-${Math.random().toString(36).substr(2, 9)}`;
    
    const nameNode = trackNode.querySelector('Name UserName');
    const name = nameNode && nameNode.getAttribute('Value') 
      ? nameNode.getAttribute('Value') 
      : `${index + 1} ${type === 'audio' ? 'Audio' : 'MIDI'}`;
    
    const colorNode = trackNode.querySelector('Color');
    const colorValue = colorNode ? parseInt(colorNode.getAttribute('Value') || '0') : 0;
    const color = colors[colorValue % colors.length];

    // Vol, Pan, Sends
    const volNode = trackNode.querySelector('DeviceChain Mixer Volume Manual');
    const volume = volNode ? parseFloat(volNode.getAttribute('Value') || '0.8') : 0.8;

    const panNode = trackNode.querySelector('DeviceChain Mixer Pan Manual');
    const pan = panNode ? parseFloat(panNode.getAttribute('Value') || '0.0') : 0.0;

    // One TrackSendHolder per return, in return order
    const sends: { [returnId: string]: number } = {};
    trackNode.querySelectorAll('DeviceChain Mixer Sends TrackSendHolder Send Manual')
      .forEach((sendNode, i) => {
        const ret = returns[i];
        if (ret) sends[ret.id] = parseFloat(sendNode.getAttribute('Value') || '0') || 0;
      });

    // Scanned plugins / VSTs under the track's device chain
    const plugins: any[] = [];
    const pluginNodes = trackNode.querySelectorAll('DeviceChain Devices *');
    pluginNodes.forEach(dev => {
      const devName = dev.nodeName;
      if (devName.includes('Vst') || devName.includes('Plugin') || devName.includes('PluginDevice')) {
        const pluginNameNode = dev.querySelector('PluginDescName, UserName');
        const nameAttr = pluginNameNode ? pluginNameNode.getAttribute('Value') : null;
        if (nameAttr) {
          plugins.push({
            id: Math.random().toString(36).substr(2, 9),
            name: nameAttr,
            type: 'vst',
            parameters: {}
          });
        }
      }
    });

    tracksList.push({
      id,
      name,
      type,
      routing: 'master',
      groupId: null,
      volume,
      pan,
      sends,
      color,
      instrument: type === 'midi' ? createDefaultInstrument() : null,
      plugins
    });

    // Placed Clips / Arranger Regions
    const clipNodes = trackNode.querySelectorAll('ArrangerClipSource AudioClip, ArrangerClipSource MidiClip');
    clipNodes.forEach((clipNode, clipIdx) => {
      const clipNameNode = clipNode.querySelector('Name');
      const clipName = clipNameNode ? clipNameNode.getAttribute('Value') || 'Clip' : 'Clip';

      const clipParent = clipNode.parentElement;
      const startNode = clipParent ? clipParent.querySelector('CurrentStart') : null;
      const endNode = clipParent ? clipParent.querySelector('CurrentEnd') : null;
      const startTime = startNode ? parseFloat(startNode.getAttribute('Value') || '0') : 0;
      const endTime = endNode ? parseFloat(endNode.getAttribute('Value') || '10') : 10;
      const duration = Math.max(0.1, endTime - startTime);

      // Ableton counts in beats. An audio clip's recording isn't in the set,
      // so only MIDI clips come across; the others are counted.
      const secondsPerBeat = 60 / tempo;
      if (clipNode.nodeName !== 'MidiClip') { skippedAudioClips++; return; }

      const notes: any[] = [];
      clipNode.querySelectorAll('Notes KeyTrack').forEach((keyTrack, k) => {
        const pitch = parseInt(keyTrack.querySelector('MidiKey')?.getAttribute('Value') || '', 10);
        if (!Number.isFinite(pitch)) return;
        keyTrack.querySelectorAll('MidiNoteEvent').forEach((ev, n) => {
          if (ev.getAttribute('IsEnabled') === 'false') return;
          const start = parseFloat(ev.getAttribute('Time') || '0') * secondsPerBeat;
          const length = parseFloat(ev.getAttribute('Duration') || '0') * secondsPerBeat;
          if (!(length > 0) || start < 0) return;
          notes.push({ id: `als-note-${index}-${clipIdx}-${k}-${n}`, pitch, start, duration: length, velocity: Math.min(1, Math.max(0.01, parseFloat(ev.getAttribute('Velocity') || '100') / 127)) });
        });
      });

      regionsList.push({
        id: `als-region-${index}-${clipIdx}-${Math.random().toString(36).substr(2, 9)}`,
        trackId: id,
        type: 'midi',
        file: clipName,
        audioBuffer: null,
        startTime: startTime * secondsPerBeat,
        duration: duration * secondsPerBeat,
        startOffset: 0,
        notes
      });
    });
  });

  return { tempo, tracksList, regionsList, skippedAudioClips };
}

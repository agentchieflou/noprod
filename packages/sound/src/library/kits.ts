// Drum kits: library sounds on the General MIDI drum notes.

export interface KitPad {
  sound: string;       // library sound id
  transpose?: number;  // semitones
  gain?: number;       // dB
}

export interface DrumKit {
  id: string;
  name: string;
  pads: Record<number, KitPad>;  // MIDI note -> sound
  chokes?: number[][];           // notes that cut each other off (a closed hat stops an open one)
}

// The General MIDI percussion map
export const GM_DRUM_NAMES: Record<number, string> = {
  35: 'Acoustic Bass Drum', 36: 'Bass Drum', 37: 'Side Stick', 38: 'Acoustic Snare', 39: 'Hand Clap',
  40: 'Electric Snare', 41: 'Low Floor Tom', 42: 'Closed Hi-Hat', 43: 'High Floor Tom', 44: 'Pedal Hi-Hat',
  45: 'Low Tom', 46: 'Open Hi-Hat', 47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash Cymbal 1', 50: 'High Tom',
  51: 'Ride Cymbal 1', 52: 'Chinese Cymbal', 53: 'Ride Bell', 54: 'Tambourine', 55: 'Splash Cymbal',
  56: 'Cowbell', 57: 'Crash Cymbal 2', 58: 'Vibraslap', 59: 'Ride Cymbal 2', 60: 'Hi Bongo', 61: 'Low Bongo',
  62: 'Mute Hi Conga', 63: 'Open Hi Conga', 64: 'Low Conga', 65: 'High Timbale', 66: 'Low Timbale',
  67: 'High Agogo', 68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas', 71: 'Short Whistle', 72: 'Long Whistle',
  73: 'Short Guiro', 74: 'Long Guiro', 75: 'Claves', 76: 'Hi Wood Block', 77: 'Low Wood Block',
  78: 'Mute Cuica', 79: 'Open Cuica', 80: 'Mute Triangle', 81: 'Open Triangle'
};

const HAT_CHOKE = [42, 44, 46];

// Everything above the core kit is shared: percussion on 54 and 56-81
const PERCUSSION_PADS: Record<number, KitPad> = {
  54: { sound: 'tambourine' }, 56: { sound: 'cowbell' }, 58: { sound: 'vibraslap' },
  60: { sound: 'bongo-high' }, 61: { sound: 'bongo-low' }, 62: { sound: 'conga-muted' },
  63: { sound: 'conga-high' }, 64: { sound: 'conga-low' }, 65: { sound: 'timbale-high' },
  66: { sound: 'timbale-low' }, 67: { sound: 'agogo-high' }, 68: { sound: 'agogo-low' },
  69: { sound: 'cabasa' }, 70: { sound: 'maracas' }, 71: { sound: 'whistle', transpose: 2 },
  72: { sound: 'whistle' }, 73: { sound: 'guiro', transpose: 2 }, 74: { sound: 'guiro' },
  75: { sound: 'clave' }, 76: { sound: 'woodblock-high' }, 77: { sound: 'woodblock-low' },
  78: { sound: 'cuica', transpose: 3 }, 79: { sound: 'cuica' },
  80: { sound: 'triangle-muted' }, 81: { sound: 'triangle-open' }
};

// Six toms from three: 41 43 45 47 48 50, low to high
const toms = (low: string, mid: string, high: string): Record<number, KitPad> => ({
  41: { sound: low, transpose: -2 }, 43: { sound: low, transpose: 1 },
  45: { sound: mid, transpose: -2 }, 47: { sound: mid, transpose: 1 },
  48: { sound: high, transpose: -1 }, 50: { sound: high, transpose: 2 }
});

const cymbals: Record<number, KitPad> = {
  49: { sound: 'crash' }, 51: { sound: 'ride' }, 52: { sound: 'china' }, 53: { sound: 'ride-bell' },
  55: { sound: 'splash' }, 57: { sound: 'crash-dark' }, 59: { sound: 'ride', transpose: -1 }
};

export const KITS: DrumKit[] = [
  {
    id: 'kit-acoustic', name: 'Acoustic Kit', chokes: [HAT_CHOKE],
    pads: {
      35: { sound: 'kick-acoustic', transpose: -2 }, 36: { sound: 'kick-acoustic' }, 37: { sound: 'rim' },
      38: { sound: 'snare-acoustic' }, 39: { sound: 'clap' }, 40: { sound: 'snare-rimshot' },
      42: { sound: 'hat-closed' }, 44: { sound: 'hat-pedal' }, 46: { sound: 'hat-open' },
      ...toms('tom-low', 'tom-mid', 'tom-high'), ...cymbals, ...PERCUSSION_PADS
    }
  },
  {
    id: 'kit-808', name: '808 Kit', chokes: [HAT_CHOKE],
    pads: {
      35: { sound: 'kick-deep' }, 36: { sound: 'kick-808' }, 37: { sound: 'rim' },
      38: { sound: 'snare-808' }, 39: { sound: 'clap' }, 40: { sound: 'snare-808', transpose: 2 },
      42: { sound: 'hat-808-closed' }, 44: { sound: 'hat-808-closed', transpose: -2 }, 46: { sound: 'hat-808-open' },
      41: { sound: 'tom-electronic', transpose: -7 }, 43: { sound: 'tom-electronic', transpose: -4 },
      45: { sound: 'tom-electronic', transpose: -2 }, 47: { sound: 'tom-electronic', transpose: 1 },
      48: { sound: 'tom-electronic', transpose: 4 }, 50: { sound: 'tom-electronic', transpose: 7 },
      ...cymbals, ...PERCUSSION_PADS
    }
  },
  {
    id: 'kit-electronic', name: 'Electronic Kit', chokes: [HAT_CHOKE],
    pads: {
      35: { sound: 'kick-short' }, 36: { sound: 'kick-punchy' }, 37: { sound: 'rim' },
      38: { sound: 'snare-tight' }, 39: { sound: 'clap-big' }, 40: { sound: 'clap' },
      42: { sound: 'hat-808-closed' }, 44: { sound: 'hat-pedal' }, 46: { sound: 'hat-808-open' },
      ...toms('tom-low', 'tom-mid', 'tom-high'), ...cymbals, ...PERCUSSION_PADS
    }
  },
  {
    id: 'kit-lofi', name: 'Lo-Fi Kit', chokes: [HAT_CHOKE],
    pads: {
      35: { sound: 'kick-deep', transpose: -1 }, 36: { sound: 'kick-lofi' }, 37: { sound: 'rim', transpose: -3 },
      38: { sound: 'snare-lofi' }, 39: { sound: 'clap-snap' }, 40: { sound: 'snare-brush' },
      42: { sound: 'hat-closed', transpose: -3 }, 44: { sound: 'hat-pedal' }, 46: { sound: 'hat-open', transpose: -3 },
      ...toms('tom-low', 'tom-mid', 'tom-high'), ...cymbals, ...PERCUSSION_PADS
    }
  },
  {
    id: 'kit-hard', name: 'Hard Kit', chokes: [HAT_CHOKE],
    pads: {
      35: { sound: 'kick-punchy' }, 36: { sound: 'kick-distorted' }, 37: { sound: 'rim' },
      38: { sound: 'snare-rimshot' }, 39: { sound: 'clap-big' }, 40: { sound: 'snare-tight' },
      42: { sound: 'hat-closed' }, 44: { sound: 'hat-pedal' }, 46: { sound: 'hat-open' },
      ...toms('tom-low', 'tom-mid', 'tom-high'), ...cymbals, ...PERCUSSION_PADS
    }
  }
];

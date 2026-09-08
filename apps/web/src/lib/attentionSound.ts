import type { AttentionSound } from "@t3tools/contracts";

/**
 * The four notification sounds, synthesised rather than shipped.
 *
 * Two reasons for tones over audio files. The bundle stays the same size, and a
 * tone can be tuned by reading the numbers below instead of opening an editor.
 * They are deliberately short and quiet: this fires while the user is away from
 * the screen, not while they are staring at it.
 */
type Tone = {
  /** Hz, played in order. */
  readonly steps: readonly number[];
  /** Seconds per step. */
  readonly stepSeconds: number;
  /** Peak gain, well under 1 so a laptop speaker does not clip. */
  readonly gain: number;
  readonly type: OscillatorType;
};

const TONES: Record<Exclude<AttentionSound, "custom">, Tone> = {
  // A rising perfect fifth: the "someone is asking" sound.
  chime: { steps: [660, 990], stepSeconds: 0.16, gain: 0.14, type: "sine" },
  // One short note, for when a ping is expected and should not be a moment.
  ping: { steps: [880], stepSeconds: 0.12, gain: 0.12, type: "triangle" },
  // Three flat notes, the most insistent of the set.
  alert: { steps: [720, 720, 720], stepSeconds: 0.11, gain: 0.16, type: "square" },
  // Two low taps, easy to miss on purpose.
  knock: { steps: [320, 260], stepSeconds: 0.1, gain: 0.18, type: "sine" },
};

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as { AudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? null;
}

let sharedContext: AudioContext | null = null;

/**
 * One context for the life of the tab. Browsers cap how many a page may create,
 * and a ping-per-context would exhaust that in a long session.
 */
function getContext(): AudioContext | null {
  if (sharedContext !== null) return sharedContext;
  const Constructor = audioContextConstructor();
  if (Constructor === null) return null;
  try {
    sharedContext = new Constructor();
    return sharedContext;
  } catch {
    return null;
  }
}

/**
 * Plays one sound, and reports whether it started.
 *
 * A `false` is not an error worth surfacing on its own: the desktop
 * notification is the louder half of the alert, and it does not depend on
 * audio being allowed. Autoplay policy is the usual reason, and a context that
 * has never seen a user gesture stays suspended.
 */
export function playAttentionSound(sound: AttentionSound): boolean {
  const context = getContext();
  if (context === null) return false;
  // A caller that asks for the custom sound without a file to play gets the
  // neutral tone: the ping matters more than which noise carries it.
  const tone = TONES[sound === "custom" ? "chime" : sound];
  try {
    void context.resume();
    const startedAt = context.currentTime;
    tone.steps.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.value = frequency;
      const stepStart = startedAt + index * tone.stepSeconds;
      const stepEnd = stepStart + tone.stepSeconds;
      // Ramped rather than switched: a square edge on a raw gain node is an
      // audible click on every note.
      gain.gain.setValueAtTime(0.0001, stepStart);
      gain.gain.exponentialRampToValueAtTime(tone.gain, stepStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, stepEnd);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(stepStart);
      oscillator.stop(stepEnd + 0.02);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Plays the user's own sound file from a signed asset URL.
 *
 * Resolves false when the file cannot be played at all, which is the caller's
 * cue to fall back to a tone: a renamed or deleted file must not cost the ping.
 * Playback is fire and forget past the first frame, so a file that starts and
 * then fails is treated as played.
 */
export async function playAttentionSoundUrl(url: string): Promise<boolean> {
  try {
    const audio = new Audio(url);
    audio.preload = "auto";
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

/** Seconds a sound occupies, for tests and for anything that waits on one. */
export function attentionSoundDurationSeconds(sound: AttentionSound): number {
  const tone = TONES[sound === "custom" ? "chime" : sound];
  return tone.steps.length * tone.stepSeconds;
}

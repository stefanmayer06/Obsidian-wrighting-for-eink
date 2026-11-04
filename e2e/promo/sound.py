"""The sound of the promo video, made from scratch (no samples, no licences):
a calm 90 bpm electric piano / bass / soft drums loop in F, and foley that
follows the picture – the pen scratching while it writes, taps, the page turn.

    python3 promo/sound.py shots/promo/video/cues.json shots/promo/video/sound.wav

cues.json is written by render.mjs: for every frame the pen (position, down)
and the cuts. The clips last whole beats (timeline.mjs), so the music and the
cuts line up; the end card starts on a downbeat with the last chord.
"""
import json
import sys
import wave

import numpy as np

SR = 44100
BPM = 90
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(11)


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def band_noise(n, lo, hi, tilt=0.0):
    """White noise limited to lo..hi Hz (soft edges), optionally tilted (dB/octave)."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    edge = 0.25
    gain = 1 / (1 + (lo / np.maximum(f, 1)) ** (2 / edge)) / (1 + (f / hi) ** (2 / edge))
    if tilt:
        gain *= (np.maximum(f, 20) / 1000) ** (tilt / 6.02)
    out = np.fft.irfft(spec * gain, n)
    return out / (np.std(out) + 1e-9)


def lowpass(x, cutoff):
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(spec / np.sqrt(1 + (f / cutoff) ** 4), len(x))


def highpass(x, cutoff):
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(spec / np.sqrt(1 + (cutoff / np.maximum(f, 1e-3)) ** 4), len(x))


def fft_convolve(x, ir):
    n = len(x) + len(ir)
    return np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)[: len(x)]


class Track:
    def __init__(self, seconds):
        self.n = int(seconds * SR)
        self.L = np.zeros(self.n)
        self.R = np.zeros(self.n)

    def add(self, sig, at, gain=1.0, pan=0.0):
        i = int(round(at * SR))
        if i >= self.n or i + len(sig) <= 0:
            return
        s = sig
        if i < 0:
            s, i = s[-i:], 0
        s = s[: self.n - i]
        self.L[i : i + len(s)] += s * gain * np.sqrt(0.5 * (1 - pan))
        self.R[i : i + len(s)] += s * gain * np.sqrt(0.5 * (1 + pan))


# ------------------------------------------------------------------ instruments


def epiano(freq, dur, vel=1.0):
    """A Rhodes-like FM tine: bright attack, warm sustain."""
    t = tt(dur + 1.2)
    index = 1.6 * np.exp(-t / 0.3) + 0.22
    car = np.sin(2 * np.pi * freq * t + index * np.sin(2 * np.pi * freq * t))
    bell = 0.07 * np.sin(2 * np.pi * min(freq * 7, 7000) * t) * np.exp(-t / 0.03)
    amp = np.exp(-t / 1.9) * (1 - np.exp(-t / 0.004))
    sig = car * amp + bell + 0.12 * np.sin(2 * np.pi * 2 * freq * t) * np.exp(-t / 0.4)
    # let go at the end of the note
    rel = np.clip((dur + 0.35 - t) / 0.35, 0, 1)
    return sig * rel * vel


def bass(freq, dur, vel=1.0):
    t = tt(dur + 0.1)
    sig = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(4 * np.pi * freq * t) * np.exp(-t / 0.25)
    amp = np.exp(-t / 1.1) * (1 - np.exp(-t / 0.006)) * np.clip((dur + 0.08 - t) / 0.08, 0, 1)
    return np.tanh(1.4 * sig * amp) * vel


def kick():
    t = tt(0.45)
    f = 44 + 82 * np.exp(-t / 0.035)
    sig = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.17)
    sig[:90] += band_noise(90, 1500, 6000) * 0.25 * np.linspace(1, 0, 90)
    return np.tanh(1.6 * sig)


def snare():
    t = tt(0.3)
    noise = band_noise(len(t), 1400, 6500, tilt=-2) * np.exp(-t / 0.075)
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.045)
    return 0.55 * noise + 0.5 * body


def hat(open_=False):
    t = tt(0.25 if open_ else 0.08)
    return band_noise(len(t), 6500, 14000) * np.exp(-t / (0.09 if open_ else 0.022))


def pad(freqs, dur):
    """A soft, slowly breathing chord under the keys."""
    t = tt(dur + 0.7)
    sig = np.zeros(len(t))
    for f in freqs:
        for det in (-0.0018, 0.0018):
            sig += sum((0.5 / h) * np.sin(2 * np.pi * f * (1 + det) * h * t + 1.3 * h) for h in (1, 2, 3))
    amp = np.clip(t / 0.4, 0, 1) * np.clip((dur + 0.7 - t) / 0.7, 0, 1) * (1 + 0.08 * np.sin(2 * np.pi * 0.4 * t))
    return lowpass(sig * amp, 1800) / len(freqs)


def chime(freq):
    t = tt(2.6)
    sig = sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / d) for a, r, d in [(1, 1, 1.1), (0.4, 2.76, 0.5), (0.18, 5.4, 0.22)])
    return sig * (1 - np.exp(-t / 0.002))


# ------------------------------------------------------------------ music

# one chord a bar (bass note, voicing); the end card starts on the last one
CHORDS = [
    (41, [53, 57, 60, 64]),  # Fmaj7
    (45, [52, 55, 60, 64]),  # Am7
    (38, [53, 57, 60, 62]),  # Dm9
    (46, [53, 57, 58, 62]),  # Bbmaj7
    (41, [53, 57, 60, 64]),  # Fmaj7
    (45, [52, 55, 60, 64]),  # Am7
    (43, [53, 58, 62, 65]),  # Gm7 … C on the last two beats
    (41, [57, 60, 64, 67]),  # Fmaj9 – the end card
]


def music(seconds, end_at):
    tr = Track(seconds)
    bars = int(np.ceil(seconds / BAR))
    for b in range(bars):
        t0 = b * BAR
        last = t0 >= end_at - 0.01
        root, voicing = CHORDS[min(b, len(CHORDS) - 1)]
        if last:
            # the last chord rings over the end card, rolled like a hand would
            for i, m in enumerate([41, 48] + voicing + [72]):
                tr.add(epiano(midi(m), BAR * 2.2, 0.9 if i else 0.7), t0 + 0.018 * i, 0.13, pan=-0.3 + 0.12 * i)
            tr.add(bass(midi(root), BAR * 2, 0.9), t0, 0.26)
            tr.add(pad([midi(m) for m in voicing], BAR * 2.2), t0, 0.05)
            break
        # keys: the chord on one, a softer push on the "and" of two, held into the next bar
        for i, m in enumerate(voicing):
            tr.add(epiano(midi(m), BEAT * 1.8, 0.95), t0 + 0.012 * i, 0.12, pan=-0.25 + 0.17 * i)
            tr.add(epiano(midi(m), BEAT * 2.6, 0.62), t0 + 1.5 * BEAT + 0.01 * i, 0.12, pan=-0.25 + 0.17 * i)
        tr.add(pad([midi(m) for m in voicing], BAR), t0, 0.09, pan=0.0)
        if b == 6:
            for i, m in enumerate([52, 58, 60, 64]):  # C7 on beats 3–4
                tr.add(epiano(midi(m), BEAT * 1.6, 0.85), t0 + 2 * BEAT + 0.012 * i, 0.12, pan=-0.25 + 0.17 * i)
        # bass: one, the "and" of two, three
        notes = [(0, root, 1.3), (1.5, root, 0.6), (2, root + 7 if b != 6 else 48, 2.05)]
        for beat, m, length in notes:
            tr.add(bass(midi(m), BEAT * length * 0.95, 1.0), t0 + beat * BEAT, 0.24)
        # drums (from the second bar on; swung eighths)
        if b >= 1:
            for beat in (0, 1.75, 2.5):
                tr.add(kick(), t0 + beat * BEAT, 0.48 if beat == 0 else 0.34)
            for beat in (1, 3):
                tr.add(snare(), t0 + beat * BEAT, 0.2, pan=0.1)
        for e in range(8):
            swing = 0.08 * BEAT if e % 2 else 0
            tr.add(hat(open_=(e == 7 and b % 2 == 1)), t0 + e * BEAT / 2 + swing, 0.05 if e % 2 else 0.075, pan=0.35)
        # into the end card: a soft cymbal swell over the last beat
        if b == len(CHORDS) - 2:
            t = tt(BEAT * 1.1)
            swell = band_noise(len(t), 3000, 13000) * (t / t[-1]) ** 2.2
            tr.add(swell, t0 + 3 * BEAT - 0.08, 0.05, pan=0.2)
    # a little room
    ir_t = tt(1.6)
    for side, seed in ((tr.L, 1), (tr.R, 2)):
        r = np.random.default_rng(seed)
        ir = lowpass(r.standard_normal(len(ir_t)), 4500) * np.exp(-ir_t / 0.42)
        ir[0] = 0
        side += 0.11 * fft_convolve(side, ir / np.sqrt(np.sum(ir**2)))
    tr.L = np.tanh(1.2 * highpass(lowpass(tr.L, 9500), 38)) / 1.2
    tr.R = np.tanh(1.2 * highpass(lowpass(tr.R, 9500), 38)) / 1.2
    return tr


# ------------------------------------------------------------------ foley


def pen_scratch(tr, cues, fps):
    """The pen on the screen: filtered noise, louder the faster it moves."""
    frames = cues["frames"]
    n = len(frames)
    speed = np.zeros(n)
    down = np.zeros(n)
    for i in range(n):
        b = frames[i]
        ink = b.get("ink")
        if ink:
            # screen pixels the pen moved on the screen since the frame before
            speed[i] = ink["dist"]
            down[i] = 1.0 if ink["down"] else 0.0
        elif b["clip"] == "end" and b.get("pen") and b["pen"]["down"]:
            a = frames[i - 1]
            down[i] = 1.0
            if a.get("pen") and a["pen"]["down"]:
                # the end card's pen is in video pixels
                speed[i] = 0.5 * np.hypot(b["pen"]["x"] - a["pen"]["x"], b["pen"]["y"] - a["pen"]["y"])
    level = np.clip(speed / 25, 0, 1) ** 0.6 * 0.8 + 0.2 * down
    # per sample, smoothed
    ts = np.arange(tr.n) / SR
    env = np.interp(ts, (np.arange(n) + 0.5) / fps, level)
    k = int(0.012 * SR)
    env = np.convolve(env, np.ones(k) / k, mode="same")
    hiss = band_noise(tr.n, 1800, 7500, tilt=-1.5)
    body = band_noise(tr.n, 350, 1400)
    grain = 0.7 + 0.3 * lowpass(rng.standard_normal(tr.n), 90) / 0.07
    sig = (0.8 * hiss + 0.35 * body) * env * np.clip(grain, 0.2, 1.6)
    tr.add(sig, 0, 0.13, pan=-0.05)


def tap():
    t = tt(0.06)
    return band_noise(len(t), 1800, 5000) * np.exp(-t / 0.006) + 0.6 * np.sin(2 * np.pi * 240 * t) * np.exp(-t / 0.012)


def page_turn():
    t = tt(0.5)
    sweep = np.zeros(len(t))
    # a band sweeping up, in a few overlapping slices
    for i, (lo, hi) in enumerate([(400, 1200), (700, 2200), (1200, 4200), (2000, 7000)]):
        w = np.exp(-(((t - 0.08 - 0.07 * i) / 0.07) ** 2))
        sweep += band_noise(len(t), lo, hi) * w
    crinkle = band_noise(len(t), 2500, 9000) * (rng.random(len(t)) < 0.004) * 4
    return (sweep * 0.8 + crinkle * np.exp(-t / 0.2)) * np.sin(np.pi * np.clip(t / 0.45, 0, 1))


def swoosh(dur=0.32, lo=600, hi=5000):
    t = tt(dur)
    return band_noise(len(t), lo, hi, tilt=-2) * np.sin(np.pi * t / dur) ** 2


def foley(seconds, cues, fps):
    tr = Track(seconds)
    pen_scratch(tr, cues, fps)
    for i, f in enumerate(cues["frames"]):
        if not f:
            continue
        at = i / fps
        if f.get("tap"):
            tr.add(tap(), at - 0.005, 0.22, pan=0.15)
        ev = f.get("event")
        if ev == "turn":
            tr.add(page_turn(), at - 0.04, 0.2, pan=-0.1)
        elif ev == "fade":
            tr.add(swoosh(), at - 0.12, 0.08)
        elif ev == "end":
            tr.add(swoosh(0.6, 300, 3000), at, 0.07)
    # the end card: a chime when the name is written
    end = next(c for c in cues["clips"] if c["id"] == "end")
    t_end = end["start"] / fps
    tr.add(chime(midi(84)), t_end + 2.3, 0.07, pan=0.2)
    tr.add(chime(midi(89)), t_end + 2.42, 0.05, pan=-0.2)
    return tr


def main():
    cues = json.load(open(sys.argv[1]))
    fps = cues["fps"]
    seconds = cues["total"] / fps
    end = next(c for c in cues["clips"] if c["id"] == "end")
    end_at = end["start"] / fps
    m = music(seconds + 0.01, end_at)
    fx = foley(seconds + 0.01, cues, fps)
    L = 0.9 * m.L + fx.L
    R = 0.9 * m.R + fx.R
    # fade in a hair, fade out over the last second and a half
    ts = np.arange(len(L)) / SR
    g = np.clip(ts / 0.03, 0, 1) * np.clip((seconds - ts) / 1.5, 0, 1) ** 1.5
    L, R = L * g, R * g
    # loudness: about -16 LUFS-ish (RMS of the busy part), peaks soft-limited
    busy = slice(int(1 * SR), int(end_at * SR))
    rms = np.sqrt(np.mean(np.concatenate([L[busy], R[busy]]) ** 2))
    gain = 10 ** (-17 / 20) / max(rms, 1e-6)
    L, R = np.tanh(L * gain * 1.1) / 1.1, np.tanh(R * gain * 1.1) / 1.1
    peak = max(np.max(np.abs(L)), np.max(np.abs(R)))
    if peak > 0.89:
        L, R = L * 0.89 / peak, R * 0.89 / peak
    out = np.stack([L, R], axis=1)
    with wave.open(sys.argv[2], "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((out * 32767).astype("<i2").tobytes())
    print(f"  ✓ {sys.argv[2]}: {seconds:.2f} s, rms gain {20 * np.log10(gain):.1f} dB, end card at {end_at:.2f} s")


if __name__ == "__main__":
    main()

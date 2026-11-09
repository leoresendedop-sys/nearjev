#!/usr/bin/env python3
"""Render the NearJev attack demo into a short 1280x720 MP4 (for an X post).

Inputs : docs/attack-demo.txt (output of `NO_COLOR=1 npm run attack-demo`)
         docs/testnet-proof.txt (output of `npm run proof:testnet`, optional)
         fixtures/charts/spoofed-profit.png
Output : docs/nearjev-attack-demo.mp4 (+ key stills in docs/demo-stills/)
Needs Pillow + ffmpeg (libx264).
"""
import os, re, subprocess, shutil, tempfile, textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1280, 720
BG, FG, DIM = (13, 17, 23), (220, 225, 232), (120, 128, 140)
RED, GREEN, YELLOW, CYAN = (248, 81, 73), (63, 185, 80), (230, 180, 40), (88, 166, 255)
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONOB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANSB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
f = lambda p, s: ImageFont.truetype(p, s)

def color_for(line):
    l = line.strip()
    if l.startswith("=="): return CYAN
    if "VERDICT : BLOCK" in l or "REFUSES" in l or "Failure" in l or l.startswith("injected") or "MISMATCH" in l or "[BLOCK]" in l or "panicked" in l or "RequiresFullAccess" in l: return RED
    if "VERDICT : ALLOW" in l or "MATCH" in l or "SuccessValue" in l or "STOPPED" in l or "0.000 NEAR" in l or "4/4" in l or "[ALLOW]" in l: return GREEN
    if "compromised" in l or l.startswith("\"Market update") : return YELLOW
    return FG

def wrap(lines, width=118):
    out = []
    for ln in lines:
        if len(ln) <= width: out.append(ln); continue
        ind = len(ln) - len(ln.lstrip())
        for i, part in enumerate(textwrap.wrap(ln.strip(), width - ind - 2)):
            out.append(" " * (ind + (2 if i else 0)) + part)
    return out

def header(d, title):
    d.rectangle([0, 0, W, 34], fill=(30, 36, 44))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([14 + i * 22, 11, 26 + i * 22, 23], fill=c)
    d.text((90, 8), title, fill=DIM, font=f(SANS, 15))
    d.text((W - 210, 8), "NearJev · Trust, but verify", fill=DIM, font=f(SANS, 15))

def terminal(lines, title, caption=None):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    header(d, title)
    font, lh, y = f(MONO, 15), 19, 46
    maxl = (H - 60 - (44 if caption else 0)) // lh
    for ln in lines[-maxl:]:
        d.text((18, y), ln, fill=color_for(ln), font=font); y += lh
    if caption:
        d.rectangle([0, H - 48, W, H], fill=(22, 27, 34))
        d.text((18, H - 37), caption, fill=YELLOW, font=f(SANSB, 20))
    return img

def card(title, sub, lines=(), accent=CYAN):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    d.text((80, 150), title, fill=FG, font=f(SANSB, 64))
    d.text((84, 240), sub, fill=accent, font=f(SANS, 28))
    y = 320
    for ln in lines:
        d.text((84, y), ln, fill=FG if not ln.startswith("#") else CYAN, font=f(SANS, 24)); y += 40
    return img

def chart_scene():
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    ch = Image.open(os.path.join(ROOT, "fixtures/charts/spoofed-profit.png")).convert("RGB")
    ch = ch.resize((int(ch.width * 0.95), int(ch.height * 0.95)))
    img.paste(ch, (40, 110))
    d.text((40, 40), "1. Prompt injection arrives as pixels", fill=YELLOW, font=f(SANSB, 34))
    x = 40 + ch.width + 30
    for i, ln in enumerate(["The agent is shown a", "\"+412% profit\" chart", "and told to send", "4.9 NEAR to unlock it.", "", "The chart is fake.", "The address is", "on a shared blocklist."]):
        d.text((x, 140 + i * 40), ln, fill=RED if i >= 5 else FG, font=f(SANS, 26))
    return img

def main():
    log = open(os.path.join(ROOT, "docs/attack-demo.txt")).read().splitlines()
    log = wrap([l for l in log])
    proof_p = os.path.join(ROOT, "docs/testnet-proof.txt")
    proof = wrap(open(proof_p).read().splitlines()) if os.path.exists(proof_p) else []
    tmp = tempfile.mkdtemp(); frames = []
    def add(img, dur):
        p = os.path.join(tmp, f"{len(frames):04d}.png"); img.save(p); frames.append((p, dur))

    add(card("NearJev", "Trust, but verify — a pre-payment check for AI agents on NEAR",
             ["Vision reads the chart the agent was shown.", "Jev vetoes: allow · warn · block.", "The wallet only holds a function-call key.", "", "#NEARHackathon · track 06 AI Security & Defense"]), 4.0)
    add(chart_scene(), 4.5)

    # Scroll the terminal log; pause on key lines.
    holds = {"VERDICT : BLOCK": (2.8, "Vision claims vs market: MISMATCH · blocklisted → BLOCK"),
             "signatures produced: 0": (2.2, "Wallet refuses to sign. No ticket, no transaction."),
             "add itself a full-access key": (2.8, "4 bypass attempts with the agent's key: all rejected"),
             "VERDICT : ALLOW": (2.0, "Control: honest chart + known merchant → ALLOW, signed"),
             "STOPPED": (3.5, "Attacker received 0 NEAR")}
    shown, caption = [], None
    cmd = "$ npm run attack-demo"
    shown.append(cmd)
    for ln in log:
        shown.append(ln)
        hit = next((k for k in holds if k in ln), None)
        if hit:
            caption = holds[hit][1]
            add(terminal(shown, "nearjev — npm run attack-demo", caption), holds[hit][0])
        else:
            add(terminal(shown, "nearjev — npm run attack-demo", caption), 0.16 if ln.strip() else 0.06)

    if proof:
        shown = ["$ npm run proof:testnet"]
        for ln in proof:
            shown.append(ln)
            hold = 2.6 if ("e) WARN" in ln or "received 0.050" in ln) else (0.22 if ln.strip() else 0.06)
            add(terminal(shown, "nearjev — live NEAR testnet", "Same rules, real NEAR testnet contract" if "e) WARN" not in ln else "Live vault refuses forged / blocklisted / BLOCK / unsigned-WARN payments"), hold)
        add(terminal(shown, "nearjev — live NEAR testnet", "Every attempt has a testnet explorer link (see docs/testnet.md)"), 3.0)

    add(card("NearJev", "github.com/leoresendedop-sys/nearjev",
             ["Built at the NEAR Hackathon · @NEARProtocol", "Visual claim check + Jev veto + function-call keys", "", "#NEARHackathon"], accent=GREEN), 4.0)

    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as fh:
        for p, dur in frames: fh.write(f"file '{p}'\nduration {dur}\n")
        fh.write(f"file '{frames[-1][0]}'\n")
    out = os.path.join(ROOT, "docs/nearjev-attack-demo.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-movflags", "+faststart", out], check=True)
    # Key stills.
    sd = os.path.join(ROOT, "docs/demo-stills"); os.makedirs(sd, exist_ok=True)
    keep = [i for i, (_, dur) in enumerate(frames) if dur >= 2.0]
    for n, i in enumerate(keep): shutil.copy(frames[i][0], os.path.join(sd, f"{n:02d}.png"))
    print(out, "total seconds:", round(sum(d for _, d in frames), 1), "stills:", len(keep))

if __name__ == "__main__":
    main()

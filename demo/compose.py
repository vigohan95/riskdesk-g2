# Turns a demo/record.py run into a 1080p video: the glasses buffer (green on black, as the wearer sees it) in the
# middle, the gesture being pressed, a caption, and the injected voice clip on the audio track at the moment it was fed.
#   python demo/compose.py demo/run-en demo/riskdesk-demo-en.mp4
# Needs Pillow and ffmpeg on PATH. Fonts: Segoe UI (en) / Microsoft YaHei (zh); pass --font-dir to use others.
import argparse, array, json, math, os, subprocess, wave
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument('run')
ap.add_argument('out')
ap.add_argument('--fps', type=int, default=30)
ap.add_argument('--font-dir', default='C:/Windows/Fonts')
args = ap.parse_args()

W, H, FPS = 1920, 1080, args.fps
SCALE = 2.25
GW, GH = int(576 * SCALE), int(288 * SCALE)
GX, GY = (W - GW) // 2, 118
TITLE, END = 4.0, 6.0
BG, FG, DIM, ACC = (12, 15, 14), (236, 240, 238), (150, 160, 156), (64, 230, 110)
SR = 16000

run = json.load(open(f'{args.run}/events.json', encoding='utf-8'))
zh = run['story'] == 'zh'
ev = run['events']
end_t = next(e['t'] for e in ev if e['type'] == 'end')


def font(size, bold=False):
    if zh:
        return ImageFont.truetype(f'{args.font_dir}/{"msyhbd.ttc" if bold else "msyh.ttc"}', size)
    return ImageFont.truetype(f'{args.font_dir}/{"segoeuib.ttf" if bold else "segoeui.ttf"}', size)


F_HEAD, F_HEAD_B, F_CAP, F_SUB, F_BADGE = font(30), font(30, True), font(44, True), font(31), font(28, True)

# glasses frames: (t, image) sorted
frames = []
for f in sorted(os.listdir(f'{args.run}/frames')):
    im = Image.open(f'{args.run}/frames/{f}')
    a = im.getchannel('A') if 'A' in im.mode else im.convert('L')
    g = Image.merge('RGB', (Image.new('L', a.size, 0), a, Image.new('L', a.size, 0)))
    frames.append((int(f[:-4]) / 1000, g.resize((GW, GH), Image.NEAREST)))

# audio track + per-frame level for the voice meter
total = TITLE + end_t + END
track = array.array('h', bytes(2 * int(total * SR + SR)))
levels = {}
for e in ev:
    if e['type'] != 'audio':
        continue
    with wave.open(e['path']) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2, e['path']
        pcm = array.array('h', w.readframes(w.getnframes()))
    off = int((TITLE + e['t']) * SR)
    for i, v in enumerate(pcm):
        track[off + i] = v
    step = SR // FPS
    for k in range(0, len(pcm), step):
        seg = pcm[k:k + step]
        rms = math.sqrt(sum(x * x for x in seg) / max(1, len(seg))) / 9000
        levels[int((TITLE + e['t']) * FPS) + k // step] = min(1.0, rms)
wav_path = args.out.rsplit('.', 1)[0] + '.wav'
with wave.open(wav_path, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(track.tobytes())


def wrap(draw, text, f, maxw):
    if not text:
        return []
    lines, cur = [], ''
    units = list(text) if zh else text.split(' ')
    for u in units:
        trial = cur + u if zh else (cur + ' ' + u).strip()
        if draw.textlength(trial, font=f) > maxw and cur:
            lines.append(cur); cur = u
        else:
            cur = trial
    lines.append(cur)
    return lines


def center(draw, y, text, f, fill):
    draw.text(((W - draw.textlength(text, font=f)) / 2, y), text, font=f, fill=fill)


def card(lines):
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    y = H / 2 - sum(l[2] for l in lines) / 2
    for text, f, h, fill in lines:
        center(d, y, text, f, fill)
        y += h
    return im


if zh:
    title = card([('RiskDesk', font(96, True), 140, FG),
                  ('在 Even Realities G2 上一眼看清风险，一句话挂好止损止盈', font(40), 90, FG),
                  ('Even Hub 模拟器实录，用自动化接口按键；Coinbase 实时行情；只有纸面持仓和 Coinbase 沙盒，没有真钱', font(28), 50, DIM)])
    endc = card([('github.com/vigohan95/riskdesk-g2', font(60, True), 110, ACC),
                  ('黑客松期间（2026-11-23 至 11-29）从零写成', font(32), 56, FG),
                  ('测试：后端 66 + 眼镜端 32；312 条真实 Whisper 转写跑完整流程，0 条错单', font(32), 56, FG),
                  ('语音识别在本机（faster-whisper），音频不出这台机器', font(32), 56, FG)])
    head_r = 'Even Hub 模拟器 · Coinbase 实时行情 · 纸面 + 沙盒'
    voice_lbl = '预录语音（模拟器无麦克风）'
else:
    title = card([('RiskDesk', font(96, True), 140, FG),
                  ('Your exits on Even Realities G2: see the risk at a glance, set it in one sentence.', font(40), 90, FG),
                  ('Recorded in the Even Hub simulator, driven by its automation API. Live Coinbase prices; paper portfolio and Coinbase sandbox only, no real money.', font(26), 50, DIM)])
    endc = card([('github.com/vigohan95/riskdesk-g2', font(60, True), 110, ACC),
                  ('Written from scratch during the hackathon, Nov 23-29, 2026', font(32), 56, FG),
                  ('Tests: backend 66 + glasses app 32; 312 real Whisper transcripts through the full path, 0 wrong orders', font(32), 56, FG),
                  ('Speech-to-text runs locally (faster-whisper): audio never leaves the machine', font(32), 56, FG)])
    head_r = 'Even Hub simulator · live Coinbase data · paper + sandbox'
    voice_lbl = 'pre-recorded voice (simulator has no mic)'

base = Image.new('RGB', (W, H), BG)
bd = ImageDraw.Draw(base)
bd.text((GX, 44), 'RiskDesk', font=F_HEAD_B, fill=FG)
bd.text((GX + bd.textlength('RiskDesk ', font=F_HEAD_B), 44), 'for Even Realities G2', font=F_HEAD, fill=DIM)
bd.text((GX + GW - bd.textlength(head_r, font=F_HEAD), 44), head_r, font=F_HEAD, fill=DIM)
bd.rounded_rectangle((GX - 14, GY - 14, GX + GW + 14, GY + GH + 14), radius=18, outline=(40, 62, 48), width=3, fill=(0, 0, 0))


def at(t, kind):
    last = None
    for e in ev:
        if e['t'] > t:
            break
        if e['type'] == kind:
            last = e
    return last


ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
                       '-i', '-', '-i', wav_path, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
                       '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', args.out], stdin=subprocess.PIPE)
n_total = int(total * FPS)
cache_key, cache = None, None
for n in range(n_total):
    t = n / FPS
    if t < TITLE:
        ff.stdin.write(title.tobytes()); continue
    if t >= TITLE + end_t:
        ff.stdin.write(endc.tobytes()); continue
    rt = t - TITLE
    fi = max(i for i, (ft, _) in enumerate(frames) if ft <= rt) if frames[0][0] <= rt else 0
    cap = at(rt, 'caption')
    g = at(rt, 'gesture')
    holding = g is not None and ('hold' in g['label'] or '按住' in g['label'])
    badge = None
    if g is not None and g['label'] != 'release' and (holding or rt - g['t'] < 1.3):
        badge = g['label']
    lvl = levels.get(n)
    key = (fi, id(cap), badge, None if lvl is None else round(lvl, 2))
    if key != cache_key:
        im = base.copy()
        im.paste(frames[fi][1], (GX, GY))
        d = ImageDraw.Draw(im)
        y = GY + GH + 40
        if badge:
            bw = d.textlength(badge.upper() if not zh else badge, font=F_BADGE) + 44
            d.rounded_rectangle((GX, y, GX + bw, y + 46), radius=23, fill=(22, 60, 34), outline=ACC, width=2)
            d.text((GX + 22, y + 6), badge.upper() if not zh else badge, font=F_BADGE, fill=ACC)
        if lvl is not None:
            lx = GX + GW - 360
            for k in range(24):
                h = 6 + 36 * lvl * (0.55 + 0.45 * math.sin(n * 0.9 + k * 1.7) ** 2)
                d.rectangle((lx + 220 + k * 6, y + 23 - h / 2, lx + 223 + k * 6, y + 23 + h / 2), fill=ACC)
            d.text((lx + 210 - d.textlength(voice_lbl, font=F_SUB), y + 4), voice_lbl, font=F_SUB, fill=DIM)
        yc = y + 70
        if cap:
            for line in wrap(d, cap['text'], F_CAP, W - 240):
                center(d, yc, line, F_CAP, FG); yc += 58
            yc += 6
            for line in wrap(d, cap.get('sub', ''), F_SUB, W - 240):
                center(d, yc, line, F_SUB, DIM); yc += 42
        cache_key, cache = key, im.tobytes()
    ff.stdin.write(cache)
ff.stdin.close()
ff.wait()
print('wrote', args.out, f'{total:.1f}s')

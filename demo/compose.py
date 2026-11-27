# Turns demo/record.py runs into a 1080p video: the glasses buffer (green on black, as the wearer sees it) in the
# middle, the gesture being pressed, a caption, and the injected voice clip on the audio track at the moment it was fed.
#   python demo/compose.py demo/run-en demo/riskdesk-demo-en.mp4
#   python demo/compose.py demo/run-en out.mp4 --hold 40:2.5 --append demo/run-zh:15.7:35.4
# --hold T:S   freezes the run at run time T for S extra seconds (lets a page be read; not used inside a voice clip)
# --append R:A:B  plays run R from A to B seconds after the main run, behind a short card (e.g. the same flow in the
#              other language). Every frame is still a simulator screenshot; holds only repeat one.
# Needs Pillow and ffmpeg on PATH. Fonts: Segoe UI (en) / Microsoft YaHei (zh); pass --font-dir to use others.
import argparse, array, json, math, os, subprocess, wave
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument('run')
ap.add_argument('out')
ap.add_argument('--fps', type=int, default=30)
ap.add_argument('--font-dir', default='C:/Windows/Fonts')
ap.add_argument('--hold', action='append', default=[], help='T:S')
ap.add_argument('--append', default=None, help='RUN:A:B')
args = ap.parse_args()

W, H, FPS = 1920, 1080, args.fps
SCALE = 2.25
GW, GH = int(576 * SCALE), int(288 * SCALE)
GX, GY = (W - GW) // 2, 118
TITLE, END, BRIDGE = 5.0, 7.0, 2.5
BG, FG, DIM, ACC = (12, 15, 14), (236, 240, 238), (150, 160, 156), (64, 230, 110)
SR = 16000


def font(size, zh, bold=False):
    if zh:
        return ImageFont.truetype(f'{args.font_dir}/{"msyhbd.ttc" if bold else "msyh.ttc"}', size)
    return ImageFont.truetype(f'{args.font_dir}/{"segoeuib.ttf" if bold else "segoeui.ttf"}', size)


def load_run(path):
    run = json.load(open(f'{path}/events.json', encoding='utf-8'))
    zh = run['story'] == 'zh'
    frames = []
    for f in sorted(os.listdir(f'{path}/frames')):
        im = Image.open(f'{path}/frames/{f}')
        a = im.getchannel('A') if 'A' in im.mode else im.convert('L')
        g = Image.merge('RGB', (Image.new('L', a.size, 0), a, Image.new('L', a.size, 0)))
        frames.append((int(f[:-4]) / 1000, g.resize((GW, GH), Image.NEAREST)))
    ev = run['events']
    return dict(zh=zh, ev=ev, frames=frames, end=next(e['t'] for e in ev if e['type'] == 'end'),
                F=dict(head=font(30, zh), head_b=font(30, zh, True), cap=font(44, zh, True), sub=font(31, zh),
                       badge=font(28, zh, True)))


main = load_run(args.run)
zh = main['zh']

# timeline: list of pieces in video order. ('card', im, dur) | ('run', ctx, a, b) | ('freeze', ctx, t, dur)
holds = sorted((float(h.split(':')[0]), float(h.split(':')[1])) for h in args.hold)
for t, _ in holds:
    for e in main['ev']:
        if e['type'] == 'audio':
            assert not (e['t'] <= t <= e['t'] + e['dur']), f'--hold {t} falls inside a voice clip'


def wrap(draw, text, f, maxw, zh):
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
    title = card([('RiskDesk', font(96, True, True), 140, FG),
                  ('离开屏幕的时候，最怕的是止损没挂。', font(44, True, True), 80, ACC),
                  ('在 Even Realities G2 上一眼看清风险，一句话挂好止损止盈', font(40, True), 90, FG),
                  ('Even Hub 模拟器实录，用自动化接口按键；Coinbase 实时行情；只有纸面持仓和 Coinbase 沙盒，没有真钱', font(28, True), 50, DIM)])
    endc = card([('github.com/vigohan95/riskdesk-g2', font(60, True, True), 110, ACC),
                  ('黑客松期间（2026-11-23 至 11-29）从零写成', font(32, True), 56, FG),
                  ('测试：后端 67 + 眼镜端 35；312 条真实 Whisper 转写跑完整流程，0 条错单', font(32, True), 56, FG),
                  ('语音识别在本机（faster-whisper），音频不出这台机器', font(32, True), 76, FG),
                  ('浏览器里直接试（不用眼镜、不用装）：vigohan95.github.io/riskdesk-g2', font(40, True, True), 60, ACC)])
    bridge_lines = [('Same flow in English', font(56, False, True), 90, ACC),
                    ('同一套流程，英文语音', font(34, True), 60, DIM)]
else:
    title = card([('RiskDesk', font(96, False, True), 140, FG),
                  ('Away from the screen is when a missing stop hurts.', font(44, False, True), 80, ACC),
                  ('Your exits on Even Realities G2: see the risk at a glance, set it in one sentence.', font(40, False), 90, FG),
                  ('Recorded in the Even Hub simulator, driven by its automation API. Live Coinbase prices; paper portfolio and Coinbase sandbox only, no real money.', font(26, False), 50, DIM)])
    endc = card([('github.com/vigohan95/riskdesk-g2', font(60, False, True), 110, ACC),
                  ('Written from scratch during the hackathon, Nov 23-29, 2026', font(32, False), 56, FG),
                  ('Tests: backend 67 + glasses app 35; 312 real Whisper transcripts through the full path, 0 wrong orders', font(32, False), 56, FG),
                  ('Speech-to-text runs locally (faster-whisper): audio never leaves the machine', font(32, False), 76, FG),
                  ('Try it in your browser, no glasses needed: vigohan95.github.io/riskdesk-g2', font(40, False, True), 60, ACC)])
    bridge_lines = [('同一套流程，中文语音', font(56, True, True), 90, ACC),
                    ('Same flow in Chinese: one sentence, both legs, 5 s undo', font(34, False), 60, DIM)]

pieces = [('card', title, TITLE)]
cur = 0.0
for t, s in holds:
    pieces.append(('run', main, cur, t)); pieces.append(('freeze', main, t, s)); cur = t
pieces.append(('run', main, cur, main['end']))
if args.append:
    path, a, b = args.append.rsplit(':', 2)
    other = load_run(path)
    pieces.append(('card', card(bridge_lines), BRIDGE))
    pieces.append(('run', other, float(a), float(b)))
pieces.append(('card', endc, END))


def dur(p):
    return p[2] if p[0] == 'card' else (p[3] - p[2] if p[0] == 'run' else p[3])


total = sum(dur(p) for p in pieces)

# audio track + per-video-frame level for the voice meter
track = array.array('h', bytes(2 * int(total * SR + SR)))
levels = {}
off_v = 0.0
for p in pieces:
    if p[0] == 'run':
        ctx, a, b = p[1], p[2], p[3]
        for e in ctx['ev']:
            if e['type'] != 'audio' or not (a <= e['t'] < b):
                continue
            with wave.open(e['path']) as w:
                assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2, e['path']
                pcm = array.array('h', w.readframes(w.getnframes()))
            start = off_v + e['t'] - a
            off = int(start * SR)
            for i, v in enumerate(pcm):
                if off + i < len(track):
                    track[off + i] = v
            step = SR // FPS
            for k in range(0, len(pcm), step):
                seg = pcm[k:k + step]
                rms = math.sqrt(sum(x * x for x in seg) / max(1, len(seg))) / 9000
                levels[int(start * FPS) + k // step] = min(1.0, rms)
    off_v += dur(p)
wav_path = args.out.rsplit('.', 1)[0] + '.wav'
with wave.open(wav_path, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(track.tobytes())


def make_base(ctx):
    base = Image.new('RGB', (W, H), BG)
    bd = ImageDraw.Draw(base)
    F = ctx['F']
    head_r = 'Even Hub 模拟器 · Coinbase 实时行情 · 纸面 + 沙盒' if ctx['zh'] else 'Even Hub simulator · live Coinbase data · paper + sandbox'
    bd.text((GX, 44), 'RiskDesk', font=F['head_b'], fill=FG)
    bd.text((GX + bd.textlength('RiskDesk ', font=F['head_b']), 44), 'for Even Realities G2', font=F['head'], fill=DIM)
    bd.text((GX + GW - bd.textlength(head_r, font=F['head']), 44), head_r, font=F['head'], fill=DIM)
    bd.rounded_rectangle((GX - 14, GY - 14, GX + GW + 14, GY + GH + 14), radius=18, outline=(40, 62, 48), width=3, fill=(0, 0, 0))
    return base


bases = {id(main): make_base(main)}


def at(ev, t, kind):
    last = None
    for e in ev:
        if e['t'] > t:
            break
        if e['type'] == kind:
            last = e
    return last


def render(ctx, rt, n, frozen):
    frames, ev, F, czh = ctx['frames'], ctx['ev'], ctx['F'], ctx['zh']
    fi = max(i for i, (ft, _) in enumerate(frames) if ft <= rt) if frames[0][0] <= rt else 0
    cap = at(ev, rt, 'caption')
    g = at(ev, rt, 'gesture')
    holding = g is not None and ('hold' in g['label'] or '按住' in g['label'])
    badge = None
    if not frozen and g is not None and g['label'] != 'release' and (holding or rt - g['t'] < 1.3):
        badge = g['label']
    lvl = levels.get(n)
    key = (id(ctx), fi, id(cap), badge, None if lvl is None else round(lvl, 2))
    if key == render.key:
        return render.img
    if id(ctx) not in bases:
        bases[id(ctx)] = make_base(ctx)
    im = bases[id(ctx)].copy()
    im.paste(frames[fi][1], (GX, GY))
    d = ImageDraw.Draw(im)
    y = GY + GH + 40
    if badge:
        txt = badge if czh else badge.upper()
        bw = d.textlength(txt, font=F['badge']) + 44
        d.rounded_rectangle((GX, y, GX + bw, y + 46), radius=23, fill=(22, 60, 34), outline=ACC, width=2)
        d.text((GX + 22, y + 6), txt, font=F['badge'], fill=ACC)
    if lvl is not None:
        voice_lbl = '预录语音（模拟器无麦克风）' if czh else 'pre-recorded voice (simulator has no mic)'
        lx = GX + GW - 360
        for k in range(24):
            h = 6 + 36 * lvl * (0.55 + 0.45 * math.sin(n * 0.9 + k * 1.7) ** 2)
            d.rectangle((lx + 220 + k * 6, y + 23 - h / 2, lx + 223 + k * 6, y + 23 + h / 2), fill=ACC)
        d.text((lx + 210 - d.textlength(voice_lbl, font=F['sub']), y + 4), voice_lbl, font=F['sub'], fill=DIM)
    yc = y + 70
    if cap:
        for line in wrap(d, cap['text'], F['cap'], W - 240, czh):
            center(d, yc, line, F['cap'], FG); yc += 58
        yc += 6
        for line in wrap(d, cap.get('sub', ''), F['sub'], W - 240, czh):
            center(d, yc, line, F['sub'], DIM); yc += 42
    render.key, render.img = key, im.tobytes()
    return render.img


render.key, render.img = None, None

ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
                       '-i', '-', '-i', wav_path, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
                       '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', args.out], stdin=subprocess.PIPE)
n = 0
for p in pieces:
    cnt = int(round(dur(p) * FPS))
    for k in range(cnt):
        if p[0] == 'card':
            ff.stdin.write(p[1].tobytes())
        elif p[0] == 'run':
            ff.stdin.write(render(p[1], p[2] + k / FPS, n, False))
        else:
            ff.stdin.write(render(p[1], p[2], n, True))
        n += 1
ff.stdin.close()
ff.wait()
print('wrote', args.out, f'{n / FPS:.1f}s', ' | '.join(f'{p[0]} {dur(p):.1f}' for p in pieces))

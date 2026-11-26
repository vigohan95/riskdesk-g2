# Scripted demo recorder: drives the Even Hub simulator through its automation API and records the glasses buffer.
#
# Needs: backend with DEV_INJECT=1, the STT service, the app, and the simulator started with --automation-port.
#   python demo/record.py --story en --out demo/run-en --sim http://127.0.0.1:9898 --srv http://127.0.0.1:8797
# Writes <out>/frames/<ms>.png (only when the glasses buffer changed), <out>/events.json (captions, gestures,
# audio placements). demo/compose.py turns that into the video. Nothing here is staged: every page in the video is a
# screenshot of the simulator's 576x288 buffer taken while this script presses the same inputs a wearer would.
#
# The simulator has no microphone, so a voice step is: long press (opens the mic exactly as on the glasses), feed a
# pre-recorded WAV into the open recording through /api/dev/inject (same 3200-byte chunks the glasses send), wait the
# length of the clip, release. The clip is placed on the video's audio track at the moment it is fed in.
import argparse, hashlib, io, json, os, threading, time, urllib.request, wave

ap = argparse.ArgumentParser()
ap.add_argument('--story', default='en', choices=['en', 'zh'])
ap.add_argument('--out', required=True)
ap.add_argument('--sim', default='http://127.0.0.1:9898')
ap.add_argument('--srv', default='http://127.0.0.1:8797')
ap.add_argument('--clips', default='demo/clips')
args = ap.parse_args()

os.makedirs(f'{args.out}/frames', exist_ok=True)
T0 = time.time()
events = []


def now():
    return round(time.time() - T0, 3)


def req(url, body=None, ctype='application/json'):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method='POST' if data is not None else 'GET', headers={'Content-Type': ctype})
    return urllib.request.urlopen(r, timeout=30).read()


def state():
    return json.loads(req(f'{args.srv}/api/state'))


stop = False


def grabber():
    last = None
    while not stop:
        t = now()
        try:
            raw = req(f'{args.sim}/api/screenshot/glasses')
        except Exception:
            time.sleep(0.1)
            continue
        h = hashlib.sha1(raw).hexdigest()
        if h != last:
            open(f'{args.out}/frames/{int(t * 1000):07d}.png', 'wb').write(raw)
            last = h
        time.sleep(max(0.0, 0.08 - (now() - t)))


def caption(text, sub=''):
    events.append({'t': now(), 'type': 'caption', 'text': text, 'sub': sub})


def gesture(action, label):
    events.append({'t': now(), 'type': 'gesture', 'label': label})
    req(f'{args.sim}/api/input', {'action': action})


def hold(s):
    time.sleep(s)


def wait_for(pred, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        s = state()
        if pred(s):
            return s
        time.sleep(0.1)
    raise SystemExit(f'timeout waiting at {now()}s')


def say(clip, label):
    path = f'{args.clips}/{clip}.wav'
    with wave.open(path) as w:
        dur = w.getnframes() / w.getframerate()
    gesture('long_press', label)
    wait_for(lambda s: s.get('voice'))
    hold(0.3)
    events.append({'t': now(), 'type': 'audio', 'path': os.path.abspath(path), 'dur': dur})
    req(f'{args.srv}/api/dev/inject', open(path, 'rb').read(), 'application/octet-stream')
    hold(dur + 0.2)
    events.append({'t': now(), 'type': 'gesture', 'label': 'release'})
    req(f'{args.sim}/api/input', {'action': 'long_press_release'})
    wait_for(lambda s: not s.get('voice'))
    hold(0.6)
    return state()


L = {
    'en': dict(
        pnl=('Glance: live Coinbase prices. Positions are valued at the price you could exit at, after fees.',
             'Paper portfolio, real market data. Nothing to set up on the glasses.'),
        risk0=('Tap: BTC risk page. No stop set, so it says what an ordinary day\'s swing would cost.',
               '24h chart from real 15-minute candles.'),
        say=('Hold and say it: "Bitcoin stop loss fifty-eight thousand, take profit sixty-four thousand"',
             'The simulator has no mic: this is a pre-recorded voice fed into the same pipeline. Speech-to-text runs locally.'),
        confirm=('One confirm page for both legs. Nothing has been placed yet.',
                 'Both prices are checked first: wrong side or wrong magnitude and neither leg is set.'),
        armed=('Tap to confirm. You still have 5 seconds to take it back.', ''),
        placed=('Placed. Whichever fires first cancels the other.', ''),
        risk1=('The risk page now shows the stop (S) and target (T) on the real 24h chart',
               'and, brightest, what you would have lost if the stop fires.'),
        menu=('Swipe for the menu. The first item is what needs doing now:',
              'BTC is covered both ways, ETH has no stop, so "Stop-loss ETH" is on top.'),
        sugg=('One tap on it: a stop at the default distance, on the same confirm page.', ''),
        placed2=('Placed. Both positions now have a stop.', ''),
        menu2=('The menu re-orders itself. Any action can still be taken back:', ''),
        undo=('{act}, confirm... then tap again within 5 seconds.', 'Undone: nothing reached the exchange.'),
        act=dict(halve='Halve {s}', close='Close {s}', stop='Stop-loss {s}', take='Take-profit {s}'),
        mag=('Misheard numbers are refused, never guessed:', '"ETH stop at one sixty-five" is not an ETH price.'),
        buy=('Voice never opens positions.', '"Buy one bitcoin" is refused and the page says why.'),
        clip_br='v_br_en', clip_mag='v_mag_en', clip_buy='d04',
        hold='hold · speaking', tap='tap', dtap='double tap', menu_g='menu', down='swipe down',
    ),
    'zh': dict(
        pnl=('一眼看盘：Coinbase 实时价格，持仓按现在能卖出的价格扣掉手续费来算。', '纸面持仓、真实行情，眼镜上不用任何设置。'),
        risk0=('单击：BTC 风险页。没设止损，就告诉你一天正常波动要亏多少。', '24 小时走势来自真实 15 分钟 K 线。'),
        say=('按住说一句：「比特币止损五万八，止盈六万四」', '模拟器没有麦克风：这是预录语音，走的是和真麦同一条管线，语音识别在本机。'),
        confirm=('一个确认页同时显示两张单，现在还什么都没挂。', '两个价格先各自检查：方向错或数量级错，两张都不挂。'),
        armed=('单击确认，之后还有 5 秒可以撤回。', ''),
        placed=('已挂上：先触发的那张自动撤掉另一张。', ''),
        risk1=('风险页的走势图上多了止损 S 和止盈 T 两条线', '最亮的一行：止损触发时这笔一共亏多少。'),
        menu=('上滑出菜单：第一项就是现在最该做的事。', 'BTC 止损止盈都有了，ETH 还没止损，所以「ETH 设止损」排在最上面。'),
        sugg=('点一下：按默认距离挂止损，同样先出确认页。', ''),
        placed2=('已挂上：两个仓位现在都有止损了。', ''),
        menu2=('菜单会跟着持仓重新排序。任何动作都还能撤回：', ''),
        undo=('{act}，确认……5 秒内再点一下', '已撤回：什么都没发到交易所。'),
        act=dict(halve='{s} 减半', close='{s} 全部平仓', stop='{s} 设止损', take='{s} 设止盈'),
        mag=('听错的数字直接拒绝，不瞎猜：', '「以太坊止损一百六十五」不是以太坊的价格。'),
        buy=('语音永远不开新仓。', '「买一个比特币」被拒，并说明原因。'),
        clip_br='v_br_zh', clip_mag='v_mag_zh', clip_buy='v_buy_zh',
        hold='按住 · 说话', tap='单击', dtap='双击', menu_g='菜单', down='下滑',
    ),
}[args.story]

threading.Thread(target=grabber, daemon=True).start()
s0 = wait_for(lambda s: s['feed']['status'] == 'live', 30)
assert all(r.get('stop') is None for r in s0['rows']), 'clear resting orders before recording (delete server/data/orders.json)'
hold(1.0)
caption(*L['pnl']); hold(7)
gesture('click', L['tap']); hold(0.8)
caption(*L['risk0']); hold(7)
caption(*L['say'])
s = say(L['clip_br'], L['hold'])
assert s['action'] and s['action']['kind'] == 'bracket', s.get('action') or s.get('notice')
caption(*L['confirm']); hold(4.5)
gesture('click', L['tap']); caption(*L['armed'])
wait_for(lambda s: s['action'] and s['action']['status'] == 'placed', 12)
caption(*L['placed'])
wait_for(lambda s: not s['action'], 12); hold(0.6)
caption(*L['risk1']); hold(7.5)  # the result page returns to the risk page it was started from
gesture('double_click', L['dtap']); hold(1.5)
# the menu puts the suggested action first (app/src/layout.ts suggest): with BTC bracketed, ETH's missing stop leads
caption(*L['menu'])
gesture('context_menu', L['menu_g']); hold(4.0)
gesture('click', L['tap'])
s = wait_for(lambda s: s['action'] and s['action']['status'] == 'proposed', 8)
assert s['action']['kind'] == 'stop' and s['action']['sym'] == 'ETH', s['action']
hold(0.4); caption(*L['sugg']); hold(4.0)
gesture('click', L['tap']); caption(*L['armed'])
wait_for(lambda s: s['action'] and s['action']['status'] == 'placed', 12)
caption(*L['placed2'])
wait_for(lambda s: not s['action'], 12); hold(1.0)
caption(*L['menu2'])
gesture('context_menu', L['menu_g']); hold(2.5)
gesture('click', L['tap'])
p = wait_for(lambda s: s['action'] and s['action']['status'] == 'proposed', 8)['action']
act = L['act'][p['kind']].format(s=p['sym'])
hold(0.4); caption(L['undo'][0].format(act=act), '')
hold(2.0)
gesture('click', L['tap']); hold(1.6)
gesture('click', L['tap']); hold(0.6)
caption(L['undo'][0].format(act=act), L['undo'][1])
wait_for(lambda s: not s['action'], 12); hold(1.0)
caption(*L['mag'])
s = say(L['clip_mag'], L['hold'])
hold(3.5)
caption(*L['buy'])
s = say(L['clip_buy'], L['hold'])
hold(3.5)
events.append({'t': now(), 'type': 'end'})
stop = True
time.sleep(0.3)
json.dump({'story': args.story, 'events': events}, open(f'{args.out}/events.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('recorded', now(), 's,', len(os.listdir(f'{args.out}/frames')), 'frames')

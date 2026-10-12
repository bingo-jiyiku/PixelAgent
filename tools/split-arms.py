# -*- coding: utf-8 -*-
"""
拆吉祥物的手：老板 2026-10-11「我要它自己的手，不是你做两个棍子上去」
girl.png 里两只手垂在裙摆两侧 —— 把它们裁成独立图层：
  assets/girl-body.png    原图（手区抹透明）
  assets/girl-arm-l.png   左臂（袖口+手）
  assets/girl-arm-r.png   右臂
静止时三层完全重合 = 和原图一模一样；TOOL 态手臂层做敲击动画 = 她自己的手在动。
用法：
  python tools/split-arms.py analyze   # 先看手的精确位置（肤色像素分布）
  python tools/split-arms.py cut       # 按分析结果裁切
"""
import sys, os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'girl.png')

def analyze():
    im = Image.open(SRC).convert('RGBA')
    W, H = im.size
    print('size:', W, H)
    px = im.load()
    # 采样几个疑似手部点的色值（画面左手/右手区域中心附近）
    for (x, y) in [(70, 280), (80, 290), (240, 280), (235, 290), (70, 300), (240, 300)]:
        print('sample', (x, y), px[x, y])
    # 肤色列分布：统计 y 240..330 每列 x 的暖肤色像素数
    col = [0] * W
    for y in range(240, min(330, H)):
        for x in range(W):
            r, g, b, a = px[x, y]
            if a < 128:
                continue
            # 暖肤色：红高、绿中、蓝略低（先宽匹配，看直方图再收）
            if r > 230 and 190 < g < 240 and 160 < b < 225 and r - b > 25:
                col[x] += 1
    # 输出有肤色像素的列段（连续段合并）
    segs = []
    s = None
    for x in range(W):
        if col[x] > 2:
            if s is None:
                s = x
        else:
            if s is not None:
                if x - s > 4:
                    segs.append((s, x))
                s = None
    if s is not None:
        segs.append((s, W - 1))
    print('skin col segments:', segs)


# 覆盖式拆手（2026-10-11 定稿）：人物肤色与裙粉几乎同色，像素 mask 切不干净，
# 改成「原图不动 + 活动手层」：
#   girl-hand-l/r.png = 裁「白条+手」完整矩形（上缘多裁 6px 袖粉，下压时盖住原手不露双影）
#   girl.png 原样保留 —— 抬起相位隐藏手层露出原手，下压相位手层 translateY(2px) 盖住原手
BOX_L = (88, 288, 118, 324)   # 左：白条 y≈294-308 / 手 y≈308-320
BOX_R = (197, 288, 227, 324)  # 右：白条 y≈292-306 / 手 y≈306-320


def cut():
    im = Image.open(SRC).convert('RGBA')
    for name, box in [('l', BOX_L), ('r', BOX_R)]:
        im.crop(box).save(os.path.join(ROOT, 'assets', f'girl-hand-{name}.png'))
    print('saved girl-hand-l.png / girl-hand-r.png（body 用原图，不挖）')
    for name in ('l', 'r'):
        a = Image.open(os.path.join(ROOT, 'assets', f'girl-hand-{name}.png'))
        a = a.resize((a.width * 6, a.height * 6), Image.NEAREST)
        bga = Image.new('RGBA', a.size, (40, 40, 60, 255)); bga.alpha_composite(a)
        bga.convert('RGB').save(os.path.join(ROOT, 'tools', f'_arm{name}.png'))
    print('debug: tools/_arml.png tools/_armr.png')


def zoom(box, scale, out):
    im = Image.open(SRC).convert('RGBA')
    c = im.crop(box)
    c = c.resize((c.width * scale, c.height * scale), Image.NEAREST)
    bg = Image.new('RGBA', c.size, (40, 40, 60, 255))
    bg.alpha_composite(c)
    bg.convert('RGB').save(out)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'analyze'
    if cmd == 'analyze':
        analyze()
    elif cmd == 'cut':
        cut()


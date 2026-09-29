#!/usr/bin/env python3
"""小区风貌数据：按真实档案与实景照片，为每个住宅小区生成风貌规则 → public/data/estates_style.json

依据
  · research/refs/dossiers/residential.json（93 个小区：坐标、landuse 多边形、年代、楼栋数与类型、房天下成交记录层数、
    立面风格/墙色/点缀色/屋顶/阳台、布局、大门、实景照片 URL、置信度）与 residential_notes.md
  · 实景照片（房天下“实景图”，每小区前 6 张）与 Esri z17 卫星对照图：逐小区目视，观察结论写在下方 SPEC 表的 why 字段；
    颜色以档案 *_hex（照片目测）为准，个别按照片补充了档案没写的构件（腰线、窗套、竖向色带、塔冠形式等），均在 why 中注明照片编号
  · 屋面颜色：Esri World Imagery z18 卫星瓦片逐栋取样（只对照片/卫星图显示有坡屋面的小区），见 sample_roofs()
  · 大门位置：Overture 2026-09 道路（区内 service/residential 道路与小区多边形边界的交点，取离主干道最近者），见 place_gate()

原则（用户要求“不要主观臆断，按真实信息和照片建模”）
  · 只有实拍照片能看清住宅立面的小区才覆盖立面风貌；只有售楼处沙盘/示范区/施工期照片的小区不覆盖立面（evidence='model'），
    无照片的小区保持通用规则（evidence='none'），这两类仍写入 json 以便查阅，但 rules 为空
  · 本地 landuse 无多边形的小区（融侨城、华远海蓝城等）不覆盖（范围无法确定）
  · 不改楼的轮廓与高度：只改墙色、点缀色、立面构件、层高（2.9–3.0 m，使渲染出的层数与真实层数一致）与屋顶附属构件
  · 照片里只看到“部分楼”的特征（如“部分高层橙褐色竖向墙段”）只加到对应的楼型档位（按层数分 low/mid/mh/high），
    看不出是哪几栋的，不做逐栋臆断；照片里几种外墙并存且无法对应到楼的（太白小区、丰盛园），按楼随机分配并在 why 中说明

用法
  python tools/build_estates.py                 # 生成 public/data/estates_style.json（需要网络取 Esri 瓦片时自动下载并缓存）
  python tools/build_estates.py --no-sat        # 不取卫星瓦片（坡屋面颜色用照片目测值，“只对红瓦楼加坡顶”的规则跳过）
  python tools/build_estates.py --data-src DIR  # Overture 数据目录（默认向上查找 data-src/overture）

输出格式（public/data/estates_style.json）
  styles[]：风貌规则（id 从 1 起），数值编码见 ENUMS；颜色为 sRGB 十六进制
  estates[]：{name, district, year, confidence, evidence, why, polys:[[x,z,…]], rules:{low,mid,mh,high → style id}, roofs:[[建筑下标, x, z, 颜色]], gate}
  运行时（src/arch/bld-gen.js）按楼的锚点落在哪个小区多边形、按“高度÷3 m”估层数选档位，套用对应 style；
  roofs 为卫星取样的逐栋坡屋面颜色（下标 + 锚点校验，buildings.bin 重排后按锚点匹配）。
"""
from __future__ import annotations

import argparse
import colorsys
import io
import json
import math
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import bldbin  # noqa: E402
import geo  # noqa: E402

DATA = ROOT / 'public' / 'data'
DOSSIER = ROOT / 'research' / 'refs' / 'dossiers' / 'residential.json'
OUT = DATA / 'estates_style.json'
FLOOR_H = 3.0  # 估层用层高（与 tools/check_heights.py RES_FLOOR_H 一致）

# ═════════════════════════ 编码（与 src/arch/bld-gen.js / bld-shader.js 一致） ═════════════════════════
ENUMS = {
    'scheme': {'generic': 0, 'modern': 1, 'neo': 2, 'deco': 3, 'brick': 4, 'old': 5, 'nc': 6, 'villa': 7},
    'finish': {'paint': 0, 'tile': 1, 'brick': 2, 'stone': 3},
    'balcony': {'none': 0, 'glass': 1, 'recess': 2, 'rail': 3, 'glassrail': 4},
    'vstrip': {'none': 0, 'flank': 1, 'core': 2, 'pilaster': 3, 'panel': 4},
    'roof': {'flat': 0, 'hip': 1, 'steep': 2, 'mansard': 3, 'deco': 4, 'cornice': 5, 'frame': 6},
    'sat': {'none': 0, 'color': 1, 'red': 2},
}
SCHEME_CN = {'generic': '通用（只改屋面）', 'modern': '现代简约', 'neo': '新古典', 'deco': 'Art Deco', 'brick': '红砖/面砖',
             'old': '老式住宅', 'nc': '新中式', 'villa': '欧式洋房/别墅'}
ROOF_CN = {'flat': '平顶', 'hip': '四坡顶', 'steep': '陡坡顶', 'mansard': '坡檐', 'deco': 'Art Deco 收分塔冠',
           'cornice': '檐口+中部升起', 'frame': '装饰构架'}
CLASSES = ('low', 'mid', 'mh', 'high')  # ≤3 层 / 4–7 / 8–11 / ≥12


def rule_for(rules, c):
    """档位规则：显式档位优先；'all' 只展开到 8 层以上（mh/high）——照片里拍到的基本是小高层/高层，
    4–7 层的在高层小区里多为会所、底商、车库出入口、幼儿园等配套（档案 types 注明“未区分”）；
    'allm' 展开到 4 层以上（照片确实拍到了多层/洋房的小区才用）。≤3 层只认显式 low（别墅/联排/卫星红瓦）"""
    if rules.get(c):
        return rules[c]
    if c in ('mh', 'high'):
        return rules.get('all') or rules.get('allm')
    if c == 'mid':
        return rules.get('allm')
    return None


def cls_of(h):
    f = max(1, int(round(h / FLOOR_H)))
    return 'low' if f <= 3 else 'mid' if f <= 7 else 'mh' if f <= 11 else 'high'


# ═════════════════════════ 多边形匹配（与调研脚本一致：landuse 名称正则；无名称的取包含档案坐标的地块） ═════════════════════════
LANDUSE_RX = {
    '天地源·枫林绿洲': r'^天地源·枫林绿洲$', '紫薇田园都市': r'^紫薇田园都市', '中华世纪城': r'^中华世纪城$', '枫叶新都市': r'^高新·枫叶新都市$',
    '绿地世纪城': r'^绿地世纪城', '鸿基新城': r'^鸿基新城$', '保利天悦': r'^西安保利天悦$', '万科翡翠国宾': r'^万科翡翠国宾$', '逸翠园': r'^逸翠园',
    '中铁缤纷南郡': r'^中铁缤纷南郡$', '万科高新华府': r'^万科高新华府$', '天地源·枫林意树': r'^天地源·枫林意树$', '万达天樾': r'^万达·天樾$',
    '金泰假日花城': r'^金泰·假日花城$', '融侨馨苑': r'^融侨紫薇馨苑$', '太白小区': r'^太白小区', '云顶园': r'^云顶园$', '易道郡·玫瑰公馆': r'^易道郡·玫瑰公馆$',
    '曲江龙邸': r'^曲江龙邸$', '金地湖城大境': r'^金地湖城大境', '金地芙蓉世家': r'^金地芙蓉世家$', '华侨城·天鹅堡': r'^华侨城-天鹅堡$',
    '华侨城·108坊': r'^华侨城108坊$', '曲江华著中城': r'^华著中城$', '中海铂宫': r'^中海铂宫$', '曲江公馆·和园': r'^曲江公馆·和园$',
    '曲江紫汀苑': r'^曲江紫汀苑$', '融创曲江印': r'^融创曲江印$', '中海熙岸': r'^中海·熙岸$', '中海观园': r'^中海观园$',
    '中国铁建万科翡翠国际': r'^中科铁建·万科翡翠国际|^翡翠国际东区$', '碧桂园云顶': r'^碧桂园·云顶$', '融创西安宸院': r'^融创西安宸院$',
    '万科城': r'^万科城$|^万科城如园$|^万科城燕园$', '绿地国际生态城': r'^绿地国际生态城', '恒大御龙湾': r'^恒大御龙湾', '融创天朗融公馆': r'^融创天朗融公馆$',
    '万科东方传奇': r'^万科·东方传奇$', '中海东郡': r'^东郡$', '中冶一曲江山': r'^中冶一曲江山$', '华润置地曲江九里': r'^华润置地·曲江九里',
    '盛世长安': r'^盛世长安$', '富力城': r'^富力城$', '大华锦绣前城': r'^大华 锦绣前城$', '万科城市之光': r'^万科·城市之光', '普华浅水湾': r'^浅水湾$',
    '浐灞天睦城': r'^浐灞天睦城$', '保利心语花园': r'^保利心语花园$', '中国铁建花语城': r'^中铁花语城小区$', '中铁琉森水岸': r'^中铁琉森水岸',
    '龙湖源著': r'^龙湖源著$', '高科麓湾国际社区': r'^高科麓湾', '三棉社区': r'^三棉社区$', '四棉社区': r'^四棉社区$|^四棉厂住宅', '纺星一区': r'^纺星一区$',
    '首创国际城': r'^首创国际城$', '锦园新世纪': r'^锦园新世纪小区$', '白桦林居': r'^白桦林居$', '白桦林间': r'^白桦林间$', '文景小区': r'^文景小区$',
    '天朗御湖': r'^天朗御湖$', '海璟台北湾': r'^海璟台北湾$', '保亿风景御园': r'^风景御园$', '荣华EE康城': r'^荣华·EE康城$', '万科金域华府': r'^万科·金域华府$',
    '长庆未央湖花园': r'^长庆未央湖花园$', '雅荷花园': r'^雅荷花园$', '雅荷春天': r'^雅荷春天$', '绿地香树花城': r'^绿地香树花城$', '华远君城': r'^华远君城$',
    '长庆兴盛园': r'^兴盛园$', '百花家园': r'^百花家园$', '万科大明宫': r'^万科大明宫$', '恒大国际城': r'^恒大国际城$', '碧桂园凤凰城': r'^碧桂园凤凰城',
    '紫薇苑·欧洲世家': r'^紫薇苑·欧洲世家$', '万科金色悦城': r'^万科·金色悦郡$', '蔚蓝花城': r'^蔚蓝花城', '丰盛园': r'^丰盛园$',
    '融创西安壹号院': r'^融创西安壹号院$', '交大一村': r'^交大一村$', '恒基碧翠锦华': r'^恒基·碧翠锦华$', '华宇凤凰城': r'^华宇凤凰城$',
    # 无名称地块（取包含档案坐标的地块）：曲江观邸、龙湖紫都城、龙湖香醍国际社区、融创东方宸院
}

# ═════════════════════════ 逐小区观察（照片编号 = residential.json photos 下标 = 调研对照图编号） ═════════════════════════
# 规则字段（全部可选）：
#   scheme  风格：modern 现代简约 / neo 新古典 / deco Art Deco / brick 红砖面砖 / old 老式住宅 / nc 新中式 / villa 欧式洋房别墅
#   wall    主墙色（可为列表：照片里几种外墙并存且对应不到具体楼时，按楼随机取）  accent 点缀色  accent2 第二点缀色
#   trim    线脚/窗套/腰线色  frame 窗框色  basec 基座色（默认 accent）  crownc 顶部色（默认 accent）
#   finish  饰面：paint 涂料 / tile 面砖 / brick 清水砖/砖纹面砖 / stone 石材（仿石）
#   base    底部基座层数（石材/深色）  crown 顶部变色层数  band 腰线周期（层，0 无，1 每层）
#   vstrip  竖向构件：flank 阳台两侧色带 / core 中部楼梯间色带 / pilaster 通高壁柱线条 / panel 整开间竖向色块
#   balcony 阳台：glass 凸阳台玻璃封闭 / recess 凹阳台 / rail 开敞阳台金属栏杆 / glassrail 开敞阳台玻璃栏板
#   bay 飘窗  surround 窗套  grille 防盗网
#   roof    屋顶：flat 平顶 / hip 四坡顶 / steep 陡坡顶（英式山墙）/ mansard 坡檐 / deco Art Deco 收分塔冠 /
#           cornice 檐口 + 中部升起 / frame 装饰构架
#   roofc   坡屋面色  sat 屋面按卫星逐栋取样：'color' 本档位全部坡顶、颜色取卫星；'red' 只有卫星为红瓦的楼加坡顶
#   P       开间组合周期（阳台/卧室窗/厨卫窗 循环）
# 档位：low ≤3 层；mid 4–7 层；mh 8–11 层；high ≥12 层（按“高度÷3 m”估层）；all = mh+high（照片拍到的是小高层/高层）；
#       allm = mid+mh+high（照片确实拍到了多层/洋房）；low 只认显式写出的（别墅/联排/卫星红瓦）。
S = {}


def spec(name, ev, why, **rules):
    S[name] = dict(ev=ev, why=why, rules=rules)


spec('天地源·枫林绿洲', 'photo', '照片1–4：米白/浅米黄涂料；照片1：阳台两侧浅橙/赭色竖向色带；凸阳台玻璃封闭+飘窗；平顶女儿墙，浅灰色檐口。'
     '“个别顶层有装饰构架”无法对应到楼，不加',
     all=dict(scheme='modern', wall='#d6ccbd', accent='#c98a5a', trim='#b9b4ac', vstrip='flank', balcony='glass', bay=True, roof='flat'))
spec('紫薇田园都市', 'photo', '照片0/1/3/5：多层与高层均为白/浅灰涂料，铝合金封闭凸阳台，灰色勒脚；照片2 个别多层红褐栏杆（对应不到楼，不加）',
     allm=dict(scheme='modern', wall='#e6e3de', accent='#9a9690', frame='#9a9690', balcony='glass', roof='flat'))
spec('中华世纪城', 'photo', '照片5/0 背景：高层浅褐/米黄面砖，底部数层较深，深褐色分段色带；顶部有构架（档案）',
     all=dict(scheme='neo', wall='#c9b49a', accent='#8a6f58', finish='tile', base=2, crown=1, balcony='glass', bay=True),
     high=dict(scheme='neo', wall='#c9b49a', accent='#8a6f58', finish='tile', base=2, crown=1, balcony='glass', bay=True, roof='frame'))
spec('枫叶新都市', 'photo', '照片3：多层为浅米黄涂料+白色线脚、檐口；照片4/5：塔楼为红褐/赭红面砖，凸窗与阳台竖列为米白色，'
     '顶部逐级收进、坡屋顶塔冠（照片5 左侧塔楼为深红色攒尖坡顶）',
     mid=dict(scheme='neo', wall='#d9c3a5', accent='#a0553d', trim='#ece6da', band=1, surround=True, balcony='glass', roof='cornice'),
     mh=dict(scheme='neo', wall='#d9c3a5', accent='#a0553d', trim='#ece6da', band=1, surround=True, balcony='glass', roof='cornice'),
     high=dict(scheme='brick', wall='#b26f57', accent='#e3d6bf', trim='#e3d6bf', finish='tile', vstrip='panel', balcony='glass', bay=True,
               roof='hip', roofc='#7e3a2e'))
spec('绿地世纪城', 'photo', '照片1–5：香槟/灰褐色仿石，竖向线条（窗列凹进、通高壁柱），顶部逐级收分；底部 2–3 层深褐色石材基座',
     all=dict(scheme='deco', wall='#c7b8a0', accent='#5d4a3c', finish='stone', base=2, vstrip='pilaster', balcony='glass', bay=True, roof='deco'))
spec('鸿基新城', 'photo', '照片0/2/4：浅米黄/沙色涂料；照片0/3：楼身中部深灰色竖向色带（楼梯间凹槽）；照片5：顶部简易构架',
     all=dict(scheme='modern', wall='#d8c9ab', accent='#6b6e72', vstrip='core', balcony='glass'),
     high=dict(scheme='modern', wall='#d8c9ab', accent='#6b6e72', vstrip='core', balcony='glass', roof='frame'))
spec('逸翠园', 'photo', '照片0/4：高层为浅肉粉/米黄面砖，红褐色面砖在阳台楼板处形成横向分段；多层洋房（照片4 右）米黄+红褐横带、灰色封闭阳台',
     allm=dict(scheme='neo', wall='#d2ab90', accent='#9a4f3a', finish='tile', band=1, bandc='#9a4f3a', balcony='glass'),
     high=dict(scheme='neo', wall='#d4ae93', accent='#9a4f3a', finish='tile', band=3, bandc='#9a4f3a', crown=1, balcony='glass', roof='frame'))
spec('中铁缤纷南郡', 'photo', '照片2–5：浅米黄/香槟色涂料；照片3/4：酒红/红褐色整开间竖向墙段；照片2/5：顶部白色格栅构架',
     all=dict(scheme='modern', wall='#d9ccb4', accent='#7b3b36', vstrip='panel', balcony='glass', roof='frame'))
spec('天地源·枫林意树', 'photo', '照片1–5：浅褐/驼色面砖墙身，米白色竖向线条与顶部檐口；凸阳台+飘窗竖向凹凸；照片4/5：顶部收分构架',
     all=dict(scheme='neo', wall='#a88a72', accent='#e3d9c8', trim='#e3d9c8', finish='tile', vstrip='pilaster', balcony='glass', bay=True,
              crown=1, crownc='#e3d9c8', roof='deco'))
spec('金泰假日花城', 'photo', '照片0–4：浅米黄/沙色涂料，深灰窗框与竖向分隔；平顶（女儿墙+简易构架）',
     all=dict(scheme='modern', wall='#cdbfa6', accent='#7d7a76', frame='#5e5d5b', vstrip='flank', balcony='glass', bay=True),
     high=dict(scheme='modern', wall='#cdbfa6', accent='#7d7a76', frame='#5e5d5b', vstrip='flank', balcony='glass', bay=True, roof='frame'))
spec('融侨馨苑', 'photo', '照片2–5：橙黄/金黄色涂料或面砖；底部 2 层深褐色石材基座；米白色腰线；照片3：顶部逐级收进的塔冠',
     all=dict(scheme='neo', wall='#d49a4f', accent='#5b4636', trim='#ece3d0', finish='tile', base=2, band=4, bandc='#ece3d0', balcony='glass',
              roof='deco'))
spec('太白小区', 'photo', '1990 年代 6–7 层砖混楼：米黄涂料（照片3）、白色小块瓷砖（照片2/5）、个别刷蓝（照片1）——几种外墙对应不到具体楼，'
     '按楼随机取米黄/白瓷砖；照片3：凸阳台下部红褐色栏板；封闭铝窗+防盗网',
     allm=dict(scheme='old', wall=['#d8c7a8', '#d8c7a8', '#e2ded5'], accent='#8b4a3a', balcony='glass', grille=True, roof='flat'))
spec('云顶园', 'photo', '照片3/4（远景，阴天）：浅米色涂料，平顶，封闭凸阳台；无更多细节',
     all=dict(scheme='modern', wall='#d9cdb9', accent='#b5aa98', balcony='glass', roof='flat'))
spec('易道郡·玫瑰公馆', 'photo', '照片0/5：浅灰米色涂料；照片0/3：深灰色竖向墙段与底部',
     all=dict(scheme='modern', wall='#cfc7bb', accent='#5d5b5c', base=1, vstrip='panel', balcony='glass', roof='flat'))
spec('曲江观邸', 'photo', '照片1/4（近景）：沙色仿石墙面，每层楼板线脚+通高壁柱，中部深褐色百叶竖列，开敞阳台黑色金属栏杆与玻璃栏板；'
     '顶部 1–2 层与檐口为深褐色，中部升起、两侧檐口收头（照片1/2/4）',
     all=dict(scheme='neo', wall='#cdb28f', accent='#8b5e45', trim='#dcc6a6', finish='stone', band=1, bandc='#dcc6a6', vstrip='core',
              balcony='rail', frame='#3a3634', crown=2, base=2, roof='cornice'))
spec('金地湖城大境', 'photo', '照片1/3：高层浅米灰石材/涂料；洋房（照片3）局部褐色面砖墙段，深灰色金属窗框与横向挑板；平顶女儿墙+金属构架',
     mid=dict(scheme='modern', wall='#d9d4c8', accent='#8a5a43', frame='#4a4a4c', finish='stone', vstrip='panel', balcony='rail', roof='flat'),
     mh=dict(scheme='modern', wall='#d9d4c8', accent='#8a5a43', frame='#4a4a4c', finish='stone', vstrip='panel', balcony='rail', roof='flat'),
     high=dict(scheme='modern', wall='#d9d4c8', accent='#8a5a43', frame='#4a4a4c', finish='stone', balcony='glass', roof='frame'))
spec('金地芙蓉世家', 'photo', '照片0/3/4/5：红褐色面砖（砖纹），每层楼板处米黄色横向线脚与檐口；照片1：勒脚为粗毛石；开敞阳台深色金属栏杆；平顶、顶层退台',
     allm=dict(scheme='brick', wall='#9c4a3c', accent='#e3d2b5', trim='#e3d2b5', finish='brick', band=1, bandc='#e3d2b5', base=0,
              balcony='rail', frame='#2f2f30', roof='flat'))
spec('华侨城·天鹅堡', 'photo', '照片3（航拍）：高层浅褐/沙色，顶部数层深褐色、塔冠收分',
     all=dict(scheme='neo', wall='#cbb08d', accent='#7e5a44', crown=3, balcony='glass', roof='deco'))
spec('华侨城·108坊', 'photo', '照片0/2/3：深灰青砖墙，深褐木格栅门/木饰面；低层合院与联排，平顶为主（卫星图深灰屋面）',
     allm=dict(scheme='nc', wall='#6f6b66', accent='#5a3d2c', trim='#8a847c', finish='brick', balcony='rail', frame='#3a2e26', roof='flat'))
spec('曲江华著中城', 'photo', '照片2/3/5：米黄色仿石材墙面，底部石材基座，高层为装饰构架收分顶；深灰褐色/铜色装饰',
     all=dict(scheme='neo', wall='#d8c6a6', accent='#8a7a66', trim='#e6d9c0', finish='stone', base=2, band=4, bandc='#e6d9c0', surround=True,
              balcony='rail', frame='#4a4038', roof='cornice'))
spec('中海铂宫', 'photo', '照片0/4/5：法式联排别墅，米黄色面砖、白色窗套，铁艺阳台栏杆；照片0/4：深灰蓝四坡屋面；卫星图红褐与深灰两色屋面（逐栋取样）',
     low=dict(scheme='villa', wall='#dcc8a8', accent='#efe8da', trim='#efe8da', finish='tile', surround=True, balcony='rail', frame='#2c2c2e',
              roof='hip', roofc='#4a5058', sat='color'),
     mid=dict(scheme='villa', wall='#dcc8a8', accent='#efe8da', trim='#efe8da', finish='tile', surround=True, balcony='rail', frame='#2c2c2e',
              roof='hip', roofc='#4a5058', sat='color'),
     high=dict(scheme='neo', wall='#dcc8a8', accent='#8a7a66', trim='#efe8da', finish='tile', surround=True, balcony='glass', roof='cornice'))
spec('曲江公馆·和园', 'photo', '照片0/3/4：洋房米白/浅米色石材，照片2/4：深褐色面砖墙段，照片4：深灰色四坡屋面；宝瓶栏杆阳台',
     low=dict(scheme='villa', wall='#d7cbb5', accent='#6e4e3f', trim='#ece4d4', finish='stone', vstrip='panel', surround=True, balcony='rail',
              frame='#e8e2d6', roof='hip', roofc='#55575b'),
     mid=dict(scheme='villa', wall='#d7cbb5', accent='#6e4e3f', trim='#ece4d4', finish='stone', vstrip='panel', surround=True, balcony='rail',
              frame='#e8e2d6', roof='hip', roofc='#55575b'),
     mh=dict(scheme='neo', wall='#d7cbb5', accent='#6e4e3f', trim='#ece4d4', finish='stone', vstrip='panel', balcony='glass', roof='cornice'),
     high=dict(scheme='neo', wall='#d7cbb5', accent='#6e4e3f', trim='#ece4d4', finish='stone', vstrip='panel', balcony='glass', roof='cornice'))
spec('曲江紫汀苑', 'photo', '照片0/2/3（仅近景）：米色石材；立面整体照片缺，只覆盖墙色',
     all=dict(scheme='modern', wall='#d6c7ad', accent='#bfae92', finish='stone', balcony='glassrail', roof='flat'))
spec('龙湖紫都城', 'photo', '照片1：浅米灰石材/涂料；照片2/3：深灰（近炭灰）墙面分段与底层单元门廊；平顶+顶部构架（档案）',
     all=dict(scheme='modern', wall='#d9d3c6', accent='#4c4a4c', finish='stone', base=1, vstrip='panel', balcony='glass'),
     high=dict(scheme='modern', wall='#d9d3c6', accent='#4c4a4c', finish='stone', base=1, vstrip='panel', balcony='glass', roof='frame'))
spec('中海熙岸', 'photo', '照片3–5：米灰色石材/仿石，竖向石材壁柱，深褐灰色金属窗框、檐口与百叶；顶部收分构架（档案）',
     all=dict(scheme='deco', wall='#cfc3ad', accent='#3e3a36', frame='#3e3a36', finish='stone', base=2, basec='#b9ad97', vstrip='pilaster',
              balcony='glass', bay=True, roof='deco'))
spec('中海观园', 'photo', '照片0 背景/照片5：高层浅褐/米黄墙面；平顶+构架（档案）', all=dict(scheme='neo', wall='#c9b397', accent='#9b6f55',
     balcony='glass', crown=1, roof='frame'))
spec('中国铁建万科翡翠国际', 'photo', '照片0/1/3：米黄/香槟色涂料，深蓝灰色窗框/玻璃竖带（整列窗与窗间墙深色），底部石材；顶部装饰构架收分',
     all=dict(scheme='neo', wall='#dccbaa', accent='#3b4a5c', frame='#3b4a5c', base=2, basec='#cdb994', vstrip='panel', balcony='glass', bay=True,
              roof='deco'))
spec('万科城', 'photo', '照片3：橙红/砖红色面砖墙身，阳台楼板处米白色横向线条与局部浅色墙段；平顶女儿墙',
     all=dict(scheme='brick', wall='#c7744f', accent='#e8dccb', trim='#e8dccb', finish='tile', band=1, bandc='#e8dccb', vstrip='flank',
              balcony='glass', roof='flat'))
spec('绿地国际生态城', 'satellite', '照片只有高层远景与景观灯柱，别墅立面未拍到 → 立面保持通用；卫星图低层联排/独栋别墅为红褐色坡屋面（逐栋取样）',
     low=dict(scheme='generic', roof='hip', roofc='#a05a45', sat='color'),
     mid=dict(scheme='generic', roof='hip', roofc='#a05a45', sat='red'))
spec('恒大御龙湾', 'photo', '照片1（晴天）：洋房/联排米黄色墙、深褐色坡屋面（卫星图亦然，逐栋取样）；宝瓶栏杆；高层为装饰构架',
     low=dict(scheme='villa', wall='#dcc39a', accent='#6e4b3a', trim='#efe4cf', surround=True, balcony='rail', frame='#efe8da', roof='hip',
              roofc='#6e4b3a', sat='color'),
     mid=dict(scheme='villa', wall='#dcc39a', accent='#6e4b3a', trim='#efe4cf', surround=True, balcony='rail', frame='#efe8da', roof='hip',
              roofc='#6e4b3a', sat='color'),
     high=dict(scheme='neo', wall='#dcc39a', accent='#6e4b3a', trim='#efe4cf', balcony='glass', roof='frame'))
spec('中海东郡', 'photo', '照片2–5：米黄/浅驼色面砖，竖向深色分隔与檐口线脚；照片0：阳台铁艺栏杆；照片5：顶部构架收头',
     all=dict(scheme='neo', wall='#d7bf9a', accent='#8d7b66', trim='#e6d6ba', finish='tile', vstrip='pilaster', balcony='rail', frame='#3a3634',
              crown=1, roof='frame'))
spec('中冶一曲江山', 'photo', '照片0/1/3/4：红褐/砖红色面砖墙身；照片3：米白色线脚、窗套与顶部檐口，顶部坡顶小塔；沿街底商',
     all=dict(scheme='brick', wall='#9c5e4a', accent='#e3d6c0', trim='#e3d6c0', finish='tile', band=3, bandc='#e3d6c0', surround=True,
              balcony='glass', roof='cornice'))
spec('盛世长安', 'photo', '照片1/3/4/5：浅肉粉/米褐色涂料；照片5：红褐色竖向墙段', all=dict(scheme='modern', wall='#d4b9a6', accent='#9a6b5a',
     vstrip='panel', balcony='glass', roof='flat'))
spec('富力城', 'photo', '照片0/1/3：浅灰白/米灰涂料，玻璃栏板阳台；照片4：部分高层为橙褐色竖向墙段（只加到高层档）',
     all=dict(scheme='modern', wall='#d9d2c6', accent='#b77b5a', balcony='glassrail', roof='flat'),
     high=dict(scheme='modern', wall='#d9d2c6', accent='#b77b5a', vstrip='panel', balcony='glassrail', roof='flat'))
spec('普华浅水湾', 'photo', '照片1/3：米黄色涂料；照片3：深灰色石材竖向墙段与底部', all=dict(scheme='modern', wall='#e0d3b8', accent='#5b5652',
     base=1, vstrip='panel', balcony='glass', roof='flat'))
spec('保利心语花园', 'photo', '照片2/3：高层米黄色、装饰构架；照片1/4/5：洋房米黄石材+深褐色面砖墙段，深色金属栏杆，顶层退台',
     mid=dict(scheme='neo', wall='#d4c09e', accent='#6f4f3f', finish='stone', vstrip='panel', balcony='rail', frame='#2f2c2a', roof='flat'),
     mh=dict(scheme='neo', wall='#d4c09e', accent='#6f4f3f', finish='stone', vstrip='panel', balcony='rail', frame='#2f2c2a', roof='flat'),
     high=dict(scheme='neo', wall='#d4c09e', accent='#6f4f3f', finish='stone', balcony='glass', roof='frame'))
spec('中铁琉森水岸', 'photo', '照片0/2/3：洋房/联排米黄/浅杏色涂料、铁艺栏杆；照片0/3：砖红/深褐色坡屋面（卫星逐栋取样）',
     low=dict(scheme='villa', wall='#e2d3b3', accent='#a4513e', trim='#efe6d2', surround=True, balcony='rail', frame='#2f2c2a', roof='hip',
              roofc='#a4513e', sat='color'),
     allm=dict(scheme='villa', wall='#e2d3b3', accent='#a4513e', trim='#efe6d2', surround=True, balcony='rail', frame='#2f2c2a', roof='hip',
              roofc='#a4513e', sat='color'))
spec('龙湖香醍国际社区', 'photo', '照片0：洋房米白/浅米色涂料、拱形门洞；照片2 与卫星图：红褐色筒瓦坡屋面（逐栋取样）；照片3：北侧高层米黄+褐色',
     low=dict(scheme='villa', wall='#e6dccb', accent='#b0553e', trim='#f0e9dc', balcony='rail', frame='#2f2c2a', roof='hip', roofc='#b0553e',
              sat='color'),
     mid=dict(scheme='villa', wall='#e6dccb', accent='#b0553e', trim='#f0e9dc', balcony='rail', frame='#2f2c2a', roof='hip', roofc='#b0553e',
              sat='color'),
     mh=dict(scheme='neo', wall='#d6c3a0', accent='#8a6a50', balcony='glass', roof='flat'),
     high=dict(scheme='neo', wall='#d6c3a0', accent='#8a6a50', balcony='glass', roof='flat'))
spec('龙湖源著', 'photo', '照片0/3/5：米黄/浅驼色仿石，竖向壁柱线条，深褐色金属栏杆与窗框；檐口，顶层退台',
     allm=dict(scheme='deco', wall='#d7c09a', accent='#6d5a4a', frame='#3f352d', finish='stone', base=1, vstrip='pilaster', balcony='rail',
              roof='cornice'))
spec('高科麓湾国际社区', 'photo', '照片0/1：洋房红砖/红褐色面砖，黄色/金色山墙线脚与檐口，深灰色陡坡瓦屋面+烟囱；照片3/4/5：高层红褐色面砖+浅色檐口',
     low=dict(scheme='brick', wall='#9c4c3c', accent='#d9b44a', trim='#d9b44a', finish='brick', surround=True, balcony='rail', frame='#2c2c2e',
              roof='steep', roofc='#4d5054'),
     mid=dict(scheme='brick', wall='#9c4c3c', accent='#d9b44a', trim='#d9b44a', finish='brick', surround=True, balcony='rail', frame='#2c2c2e',
              roof='steep', roofc='#4d5054'),
     mh=dict(scheme='brick', wall='#9a5446', accent='#d8c7a0', trim='#d8c7a0', finish='tile', crown=1, balcony='glass', roof='cornice'),
     high=dict(scheme='brick', wall='#9a5446', accent='#d8c7a0', trim='#d8c7a0', finish='tile', crown=1, balcony='glass', roof='cornice'))
spec('三棉社区', 'satellite', '无照片；卫星图部分多层为红瓦坡屋面 → 立面保持通用，只对卫星取样为红瓦的楼加坡顶',
     low=dict(scheme='generic', roof='hip', roofc='#b86a50', sat='red'),
     mid=dict(scheme='generic', roof='hip', roofc='#b86a50', sat='red'))
spec('四棉社区', 'photo', '照片0（小高层）：白/浅灰瓷砖、凸阳台防盗网；多层楼立面未拍到（保持通用），卫星图大量红瓦坡屋面（逐栋取样，只对红瓦楼加坡顶）',
     low=dict(scheme='generic', roof='hip', roofc='#c0735a', sat='red'),
     mid=dict(scheme='generic', roof='hip', roofc='#c0735a', sat='red'),
     mh=dict(scheme='old', wall='#e6e3de', accent='#c0735a', finish='tile', balcony='glass', grille=True, roof='flat'),
     high=dict(scheme='old', wall='#e6e3de', accent='#c0735a', finish='tile', balcony='glass', grille=True, roof='flat'))
spec('纺星一区', 'photo', '照片0：1990 年代砖混多层，浅米灰涂料/水刷石，封闭阳台外挂防盗网，平顶',
     allm=dict(scheme='old', wall='#d9d0c2', accent='#b3aa9c', balcony='glass', grille=True, roof='flat'))
spec('首创国际城', 'photo', '照片1–4（晴天）：浅米灰涂料，深灰褐色竖向墙段；平顶+顶部构架（档案）',
     all=dict(scheme='modern', wall='#d8d0c4', accent='#8a7f76', vstrip='panel', balcony='glass'),
     high=dict(scheme='modern', wall='#d8d0c4', accent='#8a7f76', vstrip='panel', balcony='glass', roof='frame'))
spec('锦园新世纪', 'photo', '照片3/4/5：红褐/驼色面砖，米白色线脚；照片5：顶部装饰构架与坡顶小塔',
     all=dict(scheme='neo', wall='#b98a6e', accent='#e3dccf', trim='#e3dccf', finish='tile', band=3, bandc='#e3dccf', crown=1, balcony='glass',
              roof='frame'))
spec('白桦林居', 'photo', '照片1/2/3：深红砖色面砖（砖纹）；照片1：顶层米白色退台/檐口；照片2：凹阳台+小凸窗；照片3：竖向玻璃楼梯间',
     all=dict(scheme='brick', wall='#8f4a3b', accent='#e5dfd3', trim='#e5dfd3', finish='brick', crown=1, crownc='#e5dfd3', balcony='recess',
              frame='#e8e6e0', roof='flat'))
spec('白桦林间', 'photo', '照片3/4/5：米黄/浅驼色，深褐色竖向分隔；顶部收分构架（档案）',
     all=dict(scheme='deco', wall='#cdb697', accent='#8b725b', vstrip='pilaster', balcony='glass', roof='deco'))
spec('文景小区', 'photo', '照片1/2：灰色/深灰色涂料，浅灰白色竖向墙段与阳台；平顶+顶部构架',
     all=dict(scheme='modern', wall='#8a8784', accent='#d8d2c6', vstrip='flank', balcony='glass', frame='#d8d2c6'),
     high=dict(scheme='modern', wall='#8a8784', accent='#d8d2c6', vstrip='flank', balcony='glass', frame='#d8d2c6', roof='frame'))
spec('天朗御湖', 'photo', '照片0/2/3/4：米黄/浅驼色，深褐竖向分隔与顶部构架',
     all=dict(scheme='neo', wall='#d4c0a2', accent='#8c7a66', vstrip='pilaster', balcony='glass', roof='frame'))
spec('海璟台北湾', 'photo', '照片0/2/5：橙黄/驼色涂料，米白色竖向墙段与阳台板', all=dict(scheme='modern', wall='#d9ae7e', accent='#e6ddd0',
     vstrip='flank', balcony='glass', roof='flat'))
spec('保亿风景御园', 'photo', '照片1/4/5：米黄/浅驼色石材，深褐色竖向分隔，顶部逐级收分塔冠（照片4）；凸阳台+飘窗',
     all=dict(scheme='deco', wall='#d4c09c', accent='#8c7153', finish='stone', base=2, vstrip='pilaster', balcony='glass', bay=True, roof='deco'))
spec('荣华EE康城', 'photo', '照片1/2/5：米白/浅灰涂料；照片2：黄色/蓝色竖向装饰条与顶部彩色构架；封闭阳台外装防盗网',
     all=dict(scheme='modern', wall='#e6e0d6', accent='#d9b33b', accent2='#3f6fa8', vstrip='flank', balcony='glass', grille=True, roof='frame'))
spec('万科金域华府', 'photo', '照片1/2（远景）：浅驼/沙色，深褐色竖向分隔', all=dict(scheme='modern', wall='#cdb89a', accent='#7b6a5d',
     vstrip='pilaster', balcony='glass', roof='flat'))
spec('长庆未央湖花园', 'photo', '照片1/3（远景）：多层米白/浅米黄涂料；卫星图：多层为橙红瓦坡屋面（逐栋取样）',
     allm=dict(scheme='old', wall='#e4dccb', accent='#c4775c', balcony='glass', roof='hip', roofc='#c4775c', sat='color'))
spec('雅荷花园', 'photo', '照片1/2/3：3–4 层联排/独栋，白色/米白小块瓷砖墙面；卫星图与照片2 远景：红瓦坡屋面（逐栋取样）',
     low=dict(scheme='villa', wall='#e7e4dc', accent='#b5534a', finish='tile', balcony='glass', frame='#d8d8d4', roof='hip', roofc='#b5534a',
              sat='color'),
     allm=dict(scheme='villa', wall='#e7e4dc', accent='#b5534a', finish='tile', balcony='glass', frame='#d8d8d4', roof='hip', roofc='#b5534a',
              sat='color'))
spec('雅荷春天', 'photo', '照片1/2/3：红褐色面砖竖向墙段与深灰色墙面分段相间，白色窗框；平顶',
     all=dict(scheme='brick', wall='#9a5a45', accent='#4a4a4d', finish='tile', vstrip='panel', balcony='recess', frame='#e8e6e0', roof='flat'))
spec('绿地香树花城', 'photo', '照片1：高层驼色/浅褐色，米白色竖向线条与底部石材，顶部收分；洋房立面未拍到（保持通用）',
     high=dict(scheme='deco', wall='#c8ab86', accent='#e4d7c2', trim='#e4d7c2', base=2, basec='#b39673', vstrip='pilaster', balcony='glass',
               roof='deco'))
spec('华远君城', 'photo', '照片0/3/5：浅米黄涂料，局部浅褐色竖向墙段；平顶+顶部构架',
     all=dict(scheme='modern', wall='#dccfb8', accent='#b38b6a', vstrip='panel', balcony='glass'),
     high=dict(scheme='modern', wall='#dccfb8', accent='#b38b6a', vstrip='panel', balcony='glass', roof='frame'))
spec('长庆兴盛园', 'photo', '照片1/3：浅米灰涂料；照片2/3：局部深褐/赭色墙段；照片3：顶部构架',
     all=dict(scheme='modern', wall='#d6cab5', accent='#8a6a55', vstrip='panel', balcony='glass', roof='frame'))
spec('紫薇苑·欧洲世家', 'photo', '照片0/3/4：别墅灰色文化石/面砖墙（照片2 个别红砖），白色宝瓶栏杆、窗套，玻璃阳光房；照片1/2/4 与卫星图：红/灰色四坡瓦屋面（逐栋取样）；'
     '东侧多层/小高层立面未拍到（保持通用）',
     low=dict(scheme='villa', wall='#8e8780', accent='#f0ece4', trim='#f0ece4', finish='stone', surround=True, balcony='rail', frame='#f0ece4',
              roof='hip', roofc='#a5524a', sat='color'))
spec('万科金色悦城', 'photo', '照片2–5（晴天偏暖）：暖金/驼色涂料，深褐色竖向分隔、檐口与阳台板；玻璃栏板阳台；顶部收分（照片5）；照片2 洋房同色',
     allm=dict(scheme='deco', wall='#c9a06e', accent='#6b4a33', frame='#4a3a2c', vstrip='pilaster', balcony='glassrail', roof='flat'),
     high=dict(scheme='deco', wall='#c9a06e', accent='#6b4a33', frame='#4a3a2c', vstrip='pilaster', balcony='glassrail', roof='deco'))
spec('蔚蓝花城', 'photo', '照片0/4/5：砖红/红褐色面砖；灰色面砖整列窗间墙段（竖向）与空调百叶列；楼板处白色细线、白色檐口',
     allm=dict(scheme='brick', wall='#a4524a', accent='#8d8f93', trim='#e8e4dc', finish='tile', band=1, bandc='#e8e4dc', vstrip='panel',
              balcony='glass', roof='flat'))
spec('丰盛园', 'photo', '2000 年代初多层：浅肉粉/米黄涂料（照片2/4）与橙褐色面砖（照片3）并存，对应不到具体楼，按楼随机；封闭阳台、防盗网',
     allm=dict(scheme='old', wall=['#dcc4ad', '#dcc4ad', '#c7866a'], accent='#c7866a', balcony='glass', grille=True, roof='flat'))
spec('交大一村', 'photo', '照片5：老楼为灰色清水砖墙；照片4：后建高层为粉红/肉粉色面砖；卫星图部分老楼为红色坡屋面（逐栋取样，只对红瓦楼加坡顶）',
     low=dict(scheme='old', wall='#8f8a85', accent='#bdb6ad', finish='brick', balcony='glass', grille=True, roof='hip', roofc='#a45a48', sat='red'),
     mid=dict(scheme='old', wall='#8f8a85', accent='#bdb6ad', finish='brick', balcony='glass', grille=True, roof='hip', roofc='#a45a48', sat='red'),
     mh=dict(scheme='modern', wall='#d9998a', accent='#e8dcd4', finish='tile', balcony='glass', roof='flat'),
     high=dict(scheme='modern', wall='#d9998a', accent='#e8dcd4', finish='tile', balcony='glass', roof='flat'))
spec('恒基碧翠锦华', 'photo', '照片0：浅米灰涂料，底部 2–3 层与竖向分段为深灰/近黑色石材或铝板（照片0/1），玻璃栏板阳台',
     all=dict(scheme='modern', wall='#d5cdbf', accent='#3f3c3d', base=3, vstrip='panel', balcony='glassrail', roof='flat'))

# 只有沙盘/示范区/施工期照片 → 不覆盖立面（档案 facade.notes）
MODEL_ONLY = {
    '万科翡翠国宾': '房天下“实景图”为售楼处沙盘（照片0–2），未拍到实楼',
    '融创西安宸院': '仅售楼处沙盘与示范区景观（照片0–5）',
    '融创西安壹号院': '仅示范区/售楼处与景观',
    '大华锦绣前城': '示范区（售楼处）照片，非住宅楼',
    '碧桂园云顶': '施工期照片（塔楼挂防护网）',
    '中国铁建花语城': '示范区景观，塔楼施工期',
    '万科城市之光': '雪中示范区围墙/景观',
    '融创曲江印': '仅效果图',
    '碧桂园凤凰城': '只拍到大门（照片0–2），住宅立面未拍到',
    '大华曲江公园世家': '只有儿童游乐场照片，背景楼归属未确认；且无 landuse 多边形',
    '东新城市花园': '照片为楼上俯拍周边，认不出本小区楼栋；且无 landuse 多边形',
}

# 有实景照片、但本地 landuse 没有该小区多边形（范围无法确定）→ 不覆盖
NO_POLY = {
    '融侨城': '照片1–4：暖黄/土黄色 Art Deco 高层、竖向线条、塔顶收分，底部深褐石材；照片0：石材景墙+道闸',
    '华远海蓝城': '照片2：高层深褐色面砖+米黄竖向线条；照片0：入口红砖钟塔+米黄拱门门楼',
    '西安锦园': '照片1/3/4：浅褐/驼黄色面砖小高层、弧形凸阳台；照片2：混凝土廊架式门楼',
}

# ═════════════════════════ 大门（照片有依据的门楼/门架） ═════════════════════════
# type：booth 岗亭+道闸 / pillars 门柱 / beam 门柱+横梁 / arcbeam 门柱+弧形横梁 / frame 方框门架 / paifang 三开间牌坊式 /
#       arch 拱门门楼 / arch3 三拱门楼 / gatehouse 门房（拱门洞+坡屋顶）/ canopy 钢构雨棚门廊 / bridge 二层连廊门廊
# col 主体色，acc 点缀色（横梁/屋面/字牌），h 高度（米，照片目测估计，写在 why 中），span 净宽（米，默认按道路宽）
GATES = {
    '天地源·枫林绿洲': dict(type='bridge', col='#dcd8cf', acc='#b9b4ac', h=9.0, why='照片0：横跨车道的二层连廊式门廊，白色圆柱支撑，灰白涂料；旁设石材铭牌墙'),
    '紫薇田园都市': dict(type='booth', col='#d8d6d0', acc='#e0b020', h=3.2, why='照片0：小型方盒岗亭+道闸'),
    '中华世纪城': dict(type='paifang', col='#9a9a96', acc='#4a4642', h=8.5, why='照片0：三开间石材门楼，灰色石柱+深色坡顶檐帽，门楣匾额'),
    '枫叶新都市': dict(type='arch', col='#a8634c', acc='#e3d6bf', h=11.0, why='照片0：红褐色欧式门楼建筑，拱形券门洞，两端山花坡顶'),
    '绿地世纪城': dict(type='booth', col='#8a8580', acc='#e0b020', h=3.0, why='照片0：车行入口岗亭+石材景墙铭牌，无大型门楼'),
    '逸翠园': dict(type='pillars', col='#8e8a84', acc='#e0b020', h=3.6, why='照片0：车行道闸+两侧石材门柱，中间小岗亭'),
    '融侨馨苑': dict(type='beam', col='#b8b2a8', acc='#8a2a22', h=6.5, why='照片0：跨车道横梁式门廊，梁上立体字，两侧方柱'),
    '太白小区': dict(type='beam', col='#8b4a3a', acc='#c8342a', h=5.0, why='照片0：红褐色面砖门垛+横匾“太白小区”'),
    '易道郡·玫瑰公馆': dict(type='frame', col='#4c4c4e', acc='#4c4c4e', h=8.0, why='照片3：深灰色方框门架（跨路），两侧深灰立柱'),
    '曲江观邸': dict(type='gatehouse', col='#d8c4a2', acc='#6a5a4c', h=6.5, why='照片0：米黄石材小门房+拱形门洞+坡屋顶，旁为铁艺栅门'),
    '曲江华著中城': dict(type='arch', col='#dccaa8', acc='#8a7a66', h=9.0, why='照片2：欧式对称门廊，山花+拱券'),
    '中海熙岸': dict(type='arch', col='#d6c8a8', acc='#b5a484', h=8.0, why='照片1：米黄石材拱门门楼，门楣刻字，两侧方柱'),
    '中海观园': dict(type='arch', col='#a8664a', acc='#c79a7a', h=8.0, why='照片0：赭红色石材拱门门楼+铁艺栅门，拱上檐口线脚'),
    '中国铁建万科翡翠国际': dict(type='arch3', col='#e0d2b4', acc='#2e3440', h=10.0, why='照片0/3：欧式三拱石材门楼，中门深色金属门扇'),
    '恒大御龙湾': dict(type='arch', col='#e0cfae', acc='#b8a07c', h=10.0, why='照片2（远景，细节看不清）：欧式凯旋门式门楼'),
    '中冶一曲江山': dict(type='arch3', col='#a0604a', acc='#e3d6c0', h=10.0, why='照片3/4：砖红+米白石材拱门门楼，多拱券，中部圆拱'),
    '盛世长安': dict(type='booth', col='#b8b2a8', acc='#e0b020', h=3.0, why='照片2：低矮石材景墙刻字+岗亭道闸'),
    '普华浅水湾': dict(type='pillars', col='#8e8e8c', acc='#2a2a2c', h=4.0, why='照片2：灰色石材方柱+铁艺栅门+岗亭'),
    '龙湖源著': dict(type='arch', col='#d8c49e', acc='#6d5a4a', h=9.0, wings=True, why='照片1：米黄石材拱券门楼（中部大拱+两侧方形门房、屋面坡顶）'),
    '首创国际城': dict(type='booth', col='#9a4a3a', acc='#e0b020', h=3.5, why='照片1：红砖小门房+石材景墙，旁为岗亭'),
    '锦园新世纪': dict(type='canopy', col='#9aa0a6', acc='#d8b040', h=7.5, why='照片0–2：跨车道钢构雨棚门廊，横梁金色大字，两侧门房'),
    '白桦林居': dict(type='booth', col='#d0ccc4', acc='#e0b020', h=3.0, why='照片0：简易门岗+道闸'),
    '文景小区': dict(type='pillars', col='#9a4a3a', acc='#6a6a6c', h=3.2, why='照片0：铁艺电动伸缩门+岗亭，两侧红砖门柱'),
    '天朗御湖': dict(type='gatehouse', col='#d8c6a6', acc='#8c7a66', h=6.0, why='照片0：米黄石材门亭（“TITAN ROYAL LAKE”标牌）+圆形喷泉'),
    '保亿风景御园': dict(type='gatehouse', col='#d6c29e', acc='#3a3634', h=7.0, why='照片4：米黄石材会所式门厅（对称，深色玻璃门）'),
    '荣华EE康城': dict(type='frame', col='#8a8c90', acc='#c0302a', h=10.0, why='照片0：门楼建筑：灰色竖向格栅框架+玻璃门厅，顶部红色大字'),
    '长庆未央湖花园': dict(type='paifang', col='#a8a49c', acc='#c83a2a', h=8.0, why='照片0：米灰石材牌坊式门楼（三开间，方柱+横梁），门楣金字，挂红灯笼'),
    '雅荷春天': dict(type='frame', col='#4a4a4e', acc='#4a4a4e', h=5.5, why='照片0：钢构横梁门架（深灰）+铁栅门，临街两侧为底商'),
    '绿地香树花城': dict(type='gatehouse', col='#cdb48c', acc='#d8a830', h=8.0, why='照片0：米黄石材门厅建筑，屋顶立金色大字，入口深色雨棚'),
    '长庆兴盛园': dict(type='beam', col='#d8ccb4', acc='#b0a080', h=7.0, why='照片0：米色石材横梁式门楼（方格纹），梁上刻“兴盛园”，两侧方柱'),
    '碧桂园凤凰城': dict(type='gatehouse', col='#d8c49e', acc='#3a3230', h=8.0, why='照片0–2：米黄石材方形门楼（回纹壁柱）+深色金属栅门'),
    '蔚蓝花城': dict(type='booth', col='#b8b2a8', acc='#e0b020', h=3.0, why='照片2：低矮石材景墙刻字+岗亭'),
    '丰盛园': dict(type='arcbeam', col='#e0b83a', acc='#b8282a', h=7.0, why='照片0/1：两根黄色立柱+横跨车道的红色弧形门楣，岗亭+道闸'),
    '交大一村': dict(type='pillars', col='#9a5a48', acc='#2a2a2c', h=3.0, why='照片0：铁栅门+砖门柱'),
}


# ═════════════════════════ 工具 ═════════════════════════
def log(*a):
    print('[estates]', *a, flush=True)


def hex2rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb2hex(c):
    return '#%02x%02x%02x' % tuple(int(max(0, min(255, round(v)))) for v in c)


def find_data_src(arg):
    if arg:
        return Path(arg)
    for p in [ROOT, *ROOT.parents]:
        if (p / 'data-src' / 'overture' / 'segment.parquet').exists():
            return p / 'data-src'
    return ROOT / 'data-src'


def load_polys():
    import shapely
    L = json.loads((DATA / 'landuse.json').read_text('utf-8'))['polys']
    R = [p for p in L if p['k'] == 'residential' and len(p['outer']) >= 6]
    for p in R:
        g = shapely.Polygon(np.array(p['outer']).reshape(-1, 2))
        p['g'] = g if g.is_valid else shapely.make_valid(g)
    return R


def estate_polys(e, R):
    import shapely
    rx = LANDUSE_RX.get(e['name'])
    if rx:
        ps = [p for p in R if p['n'] and re.search(rx, p['n'])]
        if ps:
            return ps
    if e.get('area_ha') is None:
        return []
    x, z = e['world_xz']
    pt = shapely.Point(x, z)
    ps = [p for p in R if p['g'].contains(pt)]
    if not ps:  # 质心落在凹多边形外：取最近且面积相符的地块
        c = sorted(R, key=lambda p: p['g'].distance(pt))[:3]
        ps = [p for p in c if p['g'].distance(pt) < 30 and abs(p['g'].area / 1e4 - e['area_ha']) < 0.2 * e['area_ha']][:1]
    return ps


# ═════════════════════════ 卫星瓦片（Esri World Imagery，z18 ≈ 0.49 m/px） ═════════════════════════
class Tiles:
    URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

    def __init__(self, cache, z=18, offline=False):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.z = z
        self.offline = offline
        self.mem = {}
        self.fetched = 0
        self.missing = 0

    def tile(self, x, y):
        k = (x, y)
        if k in self.mem:
            return self.mem[k]
        from PIL import Image
        p = self.cache / f'{self.z}_{x}_{y}.jpg'
        if not p.exists() and not self.offline:
            for _ in range(3):
                r = subprocess.run(['curl', '-s', '-L', '-m', '25', '-o', str(p), self.URL.format(z=self.z, x=x, y=y)], capture_output=True)
                if p.exists() and p.stat().st_size > 800:
                    self.fetched += 1
                    break
                time.sleep(0.5)
        im = None
        if p.exists() and p.stat().st_size > 800:
            try:
                im = np.asarray(Image.open(p).convert('RGB'))
            except Exception:
                im = None
        if im is None:
            self.missing += 1
        self.mem[k] = im
        if len(self.mem) > 600:
            self.mem.pop(next(iter(self.mem)))
        return im

    def px(self, lon, lat):
        n = 2 ** self.z * 256
        x = (lon + 180) / 360 * n
        lr = math.radians(lat)
        y = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
        return x, y

    def sample_ring(self, ring_xz, inset=1.0):
        """轮廓内（内缩 inset 米）像素的 RGB 数组"""
        import shapely
        from PIL import Image, ImageDraw
        g = shapely.Polygon(ring_xz)
        if not g.is_valid:
            g = shapely.make_valid(g)
        gi = g.buffer(-inset)
        if gi.is_empty or gi.area < 6:
            gi = g.buffer(-0.3)
        if gi.is_empty:
            return None
        if gi.geom_type != 'Polygon':
            gi = max(getattr(gi, 'geoms', [gi]), key=lambda q: q.area)
        pts = [self.px(*geo.unproject(x, z)) for x, z in gi.exterior.coords]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        x0, y0, x1, y1 = int(min(xs)), int(min(ys)), int(max(xs)) + 1, int(max(ys)) + 1
        if (x1 - x0) * (y1 - y0) > 400 * 400:
            return None
        mask = Image.new('L', (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(mask).polygon([(x - x0, y - y0) for x, y in pts], fill=255)
        mask = np.asarray(mask) > 0
        out = np.zeros((y1 - y0, x1 - x0, 3), np.uint8)
        have = np.zeros((y1 - y0, x1 - x0), bool)
        for ty in range(y0 // 256, (y1 - 1) // 256 + 1):
            for tx in range(x0 // 256, (x1 - 1) // 256 + 1):
                im = self.tile(tx, ty)
                if im is None:
                    continue
                ax0, ay0 = max(x0, tx * 256), max(y0, ty * 256)
                ax1, ay1 = min(x1, tx * 256 + 256), min(y1, ty * 256 + 256)
                if ax1 <= ax0 or ay1 <= ay0:
                    continue
                out[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = im[ay0 - ty * 256:ay1 - ty * 256, ax0 - tx * 256:ax1 - tx * 256]
                have[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = True
        m = mask & have
        if m.sum() < 8:
            return None
        return out[m].astype(np.float64)


def roof_color(px):
    """像素 → (是否红/橙瓦, 代表色 sRGB)。去掉最暗 20%（阴影）与最亮 5%（高光）后取中位数"""
    lum = px @ [0.299, 0.587, 0.114]
    lo, hi = np.percentile(lum, [20, 95])
    sel = px[(lum >= lo) & (lum <= hi)]
    if len(sel) < 5:
        sel = px
    med = np.median(sel, axis=0)
    r, g, b = med / 255.0
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    hue = h * 360
    red = (hue <= 32 or hue >= 340) and s >= 0.2 and v >= 0.22 and r > g * 1.12
    # 影像偏灰、偏暗（大气散射、JPEG）：红瓦适当提饱和度，灰瓦只限定明度
    if red:
        s2, v2 = min(0.72, max(0.32, s * 1.25)), min(0.78, max(0.36, v * 1.08))
    else:
        s2, v2 = min(0.22, s), min(0.6, max(0.24, v))
    c = colorsys.hsv_to_rgb(h, s2, v2)
    return red, rgb2hex([x * 255 for x in c]), dict(h=round(hue), s=round(s, 2), v=round(v, 2))


# ═════════════════════════ 大门位置（Overture 道路 × 小区边界） ═════════════════════════
MAJOR = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}
MINOR = {'residential', 'service', 'unclassified', 'living_street'}


class Roads:
    def __init__(self, data_src):
        import shapely
        self.ok = False
        p = Path(data_src) / 'overture' / 'segment.parquet'
        if not p.exists():
            log('未找到 Overture segment.parquet，大门位置退回“多边形边上离主干道最近处”：', p)
            self._from_roads_json()
            return
        import pyarrow.parquet as pq
        t = pq.read_table(p, columns=['class', 'subtype', 'geometry'])
        cls = t.column('class').to_pylist()
        sub = t.column('subtype').to_pylist()
        geoms = shapely.from_wkb(t.column('geometry').to_pylist())
        self.lines, self.cls = [], []
        for c, s, g in zip(cls, sub, geoms):
            if s != 'road' or c not in MAJOR | MINOR:
                continue
            xy = np.array([geo.project(x, y) for x, y in shapely.get_coordinates(g)])
            if len(xy) < 2:
                continue
            self.lines.append(shapely.LineString(xy))
            self.cls.append(c)
        self.cls = np.array(self.cls)
        self.tree = shapely.STRtree(self.lines)
        self.major = [l for l, c in zip(self.lines, self.cls) if c in MAJOR]
        self.mtree = shapely.STRtree(self.major)
        self.ok = True
        self.src = 'Overture 2026-09 segment'
        log(f'Overture 道路 {len(self.lines)} 段（主干道 {len(self.major)}）')

    def _from_roads_json(self):
        import shapely
        r = json.loads((DATA / 'roads.json').read_text('utf-8'))
        names = r['classes']
        self.lines, self.cls = [], []
        for f in r['features']:
            c = names[f['c']]
            if c not in MAJOR | MINOR or len(f['p']) < 4:
                continue
            self.lines.append(shapely.LineString(np.array(f['p']).reshape(-1, 2)))
            self.cls.append(c)
        self.cls = np.array(self.cls)
        self.tree = shapely.STRtree(self.lines)
        self.major = [l for l, c in zip(self.lines, self.cls) if c in MAJOR]
        self.mtree = shapely.STRtree(self.major)
        self.ok = True
        self.src = 'public/data/roads.json'

    def dist_major(self, pt):
        i = self.mtree.nearest(pt)
        return pt.distance(self.major[i]) if i is not None else 1e9


def place_gate(name, polys, roads, bld_polys, bld_tree):
    """区内道路（service/residential…）穿过小区边界处 = 入口候选；取离主干道最近、且门体不压楼的一个。
    返回 dict(x, z, dx, dz, span, how)：dx,dz 为车道方向（指向小区内部）"""
    import shapely
    U = shapely.union_all([p['g'] for p in polys])
    bnd = U.boundary
    cands = []
    for i in roads.tree.query(U.buffer(5), predicate='intersects'):
        line, c = roads.lines[i], roads.cls[i]
        if c not in MINOR:
            continue
        X = line.intersection(bnd)
        for pt in getattr(X, 'geoms', [X]):
            if pt.is_empty or pt.geom_type != 'Point':
                continue
            # 车道方向：交点前后 6 m
            d = line.project(pt)
            a, b = line.interpolate(max(0, d - 6)), line.interpolate(min(line.length, d + 6))
            v = np.array([b.x - a.x, b.y - a.y])
            if np.hypot(*v) < 1e-3:
                continue
            v /= np.hypot(*v)
            # 指向内部
            probe = shapely.Point(pt.x + v[0] * 8, pt.y + v[1] * 8)
            if not U.contains(probe):
                v = -v
                if not U.contains(shapely.Point(pt.x + v[0] * 8, pt.y + v[1] * 8)):
                    continue
            dm = roads.dist_major(pt)
            cands.append((dm, pt.x, pt.y, v, c))
    how = f'{roads.src}：区内道路与小区边界交点中离主干道最近者'
    # 候选离路口太近（< 30 m 内有另一条主干道）的，多半是交叉口转角，不是小区入口：降权
    def corner_pen(x, z):
        pt = shapely.Point(x, z)
        near = roads.mtree.query(pt.buffer(30), predicate='intersects')
        return 0 if len(near) <= 1 else 25
    cands = [(c[0] + corner_pen(c[1], c[2]), *c[1:]) for c in cands]
    if not cands:
        # 退回：临主干道的边界段中点附近（离主干道 < 40 m 的边界采样点里，取离多边形转角最远者），方向取边界内法线
        samp = []
        for g in [p['g'] for p in polys]:
            ring = shapely.LineString(g.exterior.coords)
            verts = [shapely.Point(c) for c in g.exterior.coords[:-1]]
            corners = []
            cs = list(g.exterior.coords)[:-1]
            for k in range(len(cs)):  # 转角：前后边夹角 > 35°
                a, b, c = np.array(cs[k - 1]), np.array(cs[k]), np.array(cs[(k + 1) % len(cs)])
                u, w = b - a, c - b
                if np.hypot(*u) > 1e-6 and np.hypot(*w) > 1e-6:
                    cosang = np.dot(u, w) / np.hypot(*u) / np.hypot(*w)
                    if cosang < math.cos(math.radians(35)):
                        corners.append(verts[k])
            for k in np.linspace(0, ring.length, max(8, int(ring.length / 8)), endpoint=False):
                pt = ring.interpolate(k)
                dm = roads.dist_major(pt)
                dc = min([pt.distance(c) for c in corners] or [1e9])
                a, b = ring.interpolate(max(0, k - 3)), ring.interpolate(min(ring.length, k + 3))
                t = np.array([b.x - a.x, b.y - a.y])
                t /= max(1e-6, np.hypot(*t))
                v = np.array([-t[1], t[0]])
                if not U.contains(shapely.Point(pt.x + v[0] * 8, pt.y + v[1] * 8)):
                    v = -v
                samp.append((dm, dc, pt.x, pt.y, v))
        if samp:
            dmin = min(s[0] for s in samp)
            near = [s for s in samp if s[0] <= max(40, dmin + 15)]
            near.sort(key=lambda s: -min(s[1], 120))
            cands = [(s[0], s[2], s[3], s[4], 'boundary') for s in near]
        how = f'{roads.src}：区内无道路穿过边界，取临主干道边界段上离转角最远处（推定）'
    if how.endswith('最近者'):
        cands.sort(key=lambda c: c[0])
    def blocked(x, z, v, w0, w1, d0, d1):
        t = np.array([-v[1], v[0]])
        box = shapely.Polygon([(x + t[0] * s + v[0] * d, z + t[1] * s + v[1] * d) for s, d in ((w0, d0), (w1, d0), (w1, d1), (w0, d1))])
        return any(bld_polys[j].intersection(box).area > 4 for j in bld_tree.query(box, predicate='intersects'))

    for dm, x, z, v, c in cands:
        # 门体（沿边界 16 m × 纵深 8 m）不压楼；门内 30 m 车道走廊（宽 7 m）不被楼挡住——入口背后一定是区内道路
        if blocked(x, z, v, -8, 8, -2, 6) or blocked(x, z, v, -3.5, 3.5, 0, 30):
            continue
        return dict(x=round(x, 1), z=round(z, 1), dx=round(float(v[0]), 4), dz=round(float(v[1]), 4), road=str(c),
                    dMajor=round(float(dm), 1), how=how)
    return None


# ═════════════════════════ 核对图：大门位置 + 卫星逐栋屋面 ═════════════════════════
def check_sheet(out_est, tiles, path):
    """每个大门一格：Esri z18 卫星底图 + 小区边界（红）+ 大门位置与车道方向（黄）；每个卫星屋面小区一格：取样楼（青=红瓦，白=其他）"""
    from PIL import Image, ImageDraw, ImageFont
    font = None
    for fp in ['/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
               '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']:
        if Path(fp).exists():
            font = ImageFont.truetype(fp, 14)
            break
    panels = []

    def crop(cx, cz, half):
        lon0, lat0 = geo.unproject(cx - half, cz + half)
        lon1, lat1 = geo.unproject(cx + half, cz - half)
        x0, y0 = tiles.px(lon0, lat1)
        x1, y1 = tiles.px(lon1, lat0)
        x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
        im = Image.new('RGB', (x1 - x0, y1 - y0), (40, 40, 40))
        for ty in range(y0 // 256, (y1 - 1) // 256 + 1):
            for tx in range(x0 // 256, (x1 - 1) // 256 + 1):
                t = tiles.tile(tx, ty)
                if t is not None:
                    im.paste(Image.fromarray(t), (tx * 256 - x0, ty * 256 - y0))
        return im, lambda x, z: (tiles.px(*geo.unproject(x, z))[0] - x0, tiles.px(*geo.unproject(x, z))[1] - y0)

    for e in out_est:
        g = e.get('gate')
        if not g:
            continue
        im, P = crop(g['x'], g['z'], 90)
        d = ImageDraw.Draw(im)
        for poly in e['polys']:
            pts = [P(poly[k], poly[k + 1]) for k in range(0, len(poly), 2)]
            d.line(pts + [pts[0]], fill=(255, 40, 40), width=2)
        gx, gy = P(g['x'], g['z'])
        hx, hy = P(g['x'] + g['dx'] * 25, g['z'] + g['dz'] * 25)
        d.line([(gx, gy), (hx, hy)], fill=(255, 230, 0), width=3)
        d.ellipse([gx - 7, gy - 7, gx + 7, gy + 7], outline=(255, 230, 0), width=3)
        d.rectangle([0, 0, im.width, 20], fill=(0, 0, 0))
        d.text((4, 2), f"{e['name']} 大门·{g['type']}（{g['road']}，距主干道{g['dMajor']:.0f}m）", fill=(255, 255, 255), font=font)
        panels.append(im.resize((360, 360)))
    for e in out_est:
        if not e.get('roofs') or not e['polys']:
            continue
        xs = [v for p in e['polys'] for v in p[0::2]]
        zs = [v for p in e['polys'] for v in p[1::2]]
        cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
        half = max(max(xs) - min(xs), max(zs) - min(zs)) / 2 + 20
        if half > 450:
            continue
        im, P = crop(cx, cz, half)
        d = ImageDraw.Draw(im)
        for poly in e['polys']:
            pts = [P(poly[k], poly[k + 1]) for k in range(0, len(poly), 2)]
            d.line(pts + [pts[0]], fill=(255, 40, 40), width=2)
        for i, x, z, col, red in e['roofs']:
            px, py = P(x, z)
            d.ellipse([px - 4, py - 4, px + 4, py + 4], fill=hex2rgb(col), outline=(0, 255, 255) if red else (255, 255, 255))
        d.rectangle([0, 0, im.width, 22], fill=(0, 0, 0))
        d.text((4, 2), f"{e['name']} 卫星屋面取样 {len(e['roofs'])} 栋（圆点=取样色，青框=红瓦）", fill=(255, 255, 255), font=font)
        panels.append(im.resize((360, 360)))
    if not panels:
        return
    cols = 6
    rows = (len(panels) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * 364, rows * 364), (20, 20, 20))
    for k, pnl in enumerate(panels):
        sheet.paste(pnl, ((k % cols) * 364 + 2, (k // cols) * 364 + 2))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, quality=82)
    log(f'核对图 {path}（{len(panels)} 格）')


# ═════════════════════════ 主流程 ═════════════════════════
def main():
    import shapely
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--no-sat', action='store_true', help='不取卫星瓦片')
    ap.add_argument('--data-src', default=None)
    ap.add_argument('--out', default=str(OUT))
    ap.add_argument('--check', default=None, help='输出核对图（大门位置 + 卫星屋面取样）到该路径（jpg）')
    args = ap.parse_args()
    data_src = find_data_src(args.data_src)
    dossiers = json.loads(DOSSIER.read_text('utf-8'))
    R = load_polys()
    B = bldbin.read()
    N = B['n']
    rings = [bldbin.ring(B, i) for i in range(N)]
    bpolys = np.array([shapely.Polygon(r) if len(r) >= 3 else shapely.Polygon() for r in rings], dtype=object)
    area = shapely.area(bpolys)
    anchors = shapely.points(np.c_[B['ax'], B['az']])
    atree = shapely.STRtree(anchors)
    btree = shapely.STRtree(bpolys)
    roads = Roads(data_src)
    tiles = None if args.no_sat else Tiles(ROOT / 'data-src' / 'tiles_esri18')

    styles, style_key = [], {}

    def style_id(r):
        """规则 → 数值化 style（相同规则共用一个 id）"""
        E = ENUMS
        sch = r.get('scheme', 'modern')
        wall = r.get('wall')
        walls = wall if isinstance(wall, list) else ([wall] if wall else [])
        acc = r.get('accent')
        st = dict(
            scheme=E['scheme'][sch], finish=E['finish'][r.get('finish', 'paint')], balcony=E['balcony'][r.get('balcony', 'glass')],
            vstrip=E['vstrip'][r.get('vstrip', 'none')], base=int(r.get('base', 0)), crown=int(r.get('crown', 0)), band=int(r.get('band', 0)),
            flags=(1 if r.get('surround') else 0) | (2 if r.get('bay') else 0) | (4 if r.get('grille') else 0),
            walls=walls, accent=acc, accent2=r.get('accent2') or acc, trim=r.get('trim') or acc,
            basec=r.get('basec') or acc, crownc=r.get('crownc') or acc, bandc=r.get('bandc') or r.get('trim') or acc,
            frame=r.get('frame'), glass=r.get('glass', '#3a4a4c'), P=int(r.get('P', 3)),
            roof=E['roof'][r.get('roof', 'flat')], roofc=r.get('roofc'), fh=float(r.get('fh', 2.95)),
            sat={'color': 1, 'red': 2}.get(r.get('sat'), 0),
        )
        key = json.dumps(st, sort_keys=True, ensure_ascii=False)
        if key not in style_key:
            st['id'] = len(styles) + 1
            st['desc'] = f"{SCHEME_CN[sch]}·{ROOF_CN[r.get('roof', 'flat')]}"
            styles.append(st)
            style_key[key] = st['id']
        return style_key[key]

    out_est = []
    cover = Counter()
    n_bld_total = 0
    for e in dossiers:
        name = e['name']
        f = e.get('facade') or {}
        polys = estate_polys(e, R)
        rec = dict(name=name, district=e.get('district'), year=e.get('year'), confidence=e.get('confidence'),
                   photos=len(e.get('photos') or []), style_cn=f.get('style'), polys=[], rules={}, roofs=[], gate=None)
        if name in S:
            ev, why, rules = S[name]['ev'], S[name]['why'], S[name]['rules']
        elif name in MODEL_ONLY:
            ev, why, rules = 'model', MODEL_ONLY[name] + ' → 不覆盖立面，保持通用规则', {}
        elif name in NO_POLY:
            ev, why, rules = 'nopoly', NO_POLY[name] + '；但本地 landuse 无该小区多边形，范围无法确定 → 不覆盖', {}
        else:
            ev, why, rules = 'none', '房天下无实景图/无可用立面照片 → 保持通用规则', {}
        if not polys:
            if rules:
                why += '；本地 landuse 无该小区多边形，范围无法确定 → 不覆盖'
            ev = ev if not rules else 'nopoly'
            rules = {}
        rec['evidence'] = ev
        rec['why'] = why
        rec['polys'] = [[round(float(v), 1) for v in np.array(p['g'].exterior.coords)[:-1].ravel()] for p in polys]
        rec['polyNames'] = [p['n'] or '（未命名）' for p in polys]
        # 档位 → style
        for c in CLASSES:
            r = rule_for(rules, c)
            if r:
                rec['rules'][c] = style_id(r)
        # 楼栋统计 + 卫星屋面
        if polys and rec['rules']:
            U = shapely.union_all([p['g'] for p in polys])
            idx = atree.query(U, predicate='contains')
            per = Counter()
            sat_rows = []
            for i in idx:
                i = int(i)
                if B['kind'][i] not in (0, 1) or (B['style'][i] >> 4) >= 5 or area[i] < 40 or B['h'][i] < 4:
                    continue
                c = cls_of(float(B['h'][i]))
                sid = rec['rules'].get(c)
                if not sid:
                    continue
                per[c] += 1
                r = rule_for(rules, c)
                if r.get('sat') and tiles is not None:
                    px = tiles.sample_ring(rings[i], inset=1.2)
                    if px is None:
                        continue
                    red, col, hsv = roof_color(px)
                    if r['sat'] == 'red' and not red:
                        continue
                    if r['sat'] == 'color' and not red and r.get('roofc') and hex2rgb(r['roofc'])[0] > 1.4 * hex2rgb(r['roofc'])[2]:
                        # 照片为红瓦的小区里取到灰色：多为被树冠/阴影遮挡或平顶配套，颜色仍取照片目测值
                        col = r['roofc']
                    sat_rows.append([i, round(float(B['ax'][i]), 2), round(float(B['az'][i]), 2), col, int(red)])
            rec['roofs'] = sat_rows
            rec['count'] = dict(per)
            n_bld_total += sum(per.values())
            cover[ev] += 1
        # 大门
        g = GATES.get(name)
        if g and polys:
            pos = place_gate(name, polys, roads, bpolys, btree)
            if pos:
                rec['gate'] = dict(g, **pos)
            else:
                rec['gateNote'] = '未找到不压楼的入口位置，未加'
        out_est.append(rec)
        if rec['rules'] or rec['gate']:
            log(f"{name}：{ev}，档位 {rec['rules']}，楼 {rec.get('count', {})}，卫星屋面 {len(rec['roofs'])}，大门 {'有' if rec['gate'] else '无'}")

    doc = dict(
        version=1,
        generated=time.strftime('%Y-%m-%d'),
        source='research/refs/dossiers/residential.json + 实景照片逐小区观察（tools/build_estates.py SPEC 表）+ Esri z18 卫星逐栋屋面取样 + '
               'Overture 2026-09 道路（大门定位）',
        classes=dict(low='≤3 层', mid='4–7 层', mh='8–11 层', high='≥12 层', floorH=FLOOR_H),
        enums=ENUMS,
        styles=styles,
        estates=out_est,
    )
    Path(args.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    if args.check and tiles is not None:
        check_sheet(out_est, tiles, args.check)
    ng = sum(1 for e in out_est if e['gate'])
    log(f'输出 {args.out}：{len(out_est)} 个小区，覆盖风貌 {sum(1 for e in out_est if e["rules"])} 个（{dict(cover)}），'
        f'楼 {n_bld_total} 栋，style {len(styles)} 种，大门 {ng} 座' + (f'；卫星瓦片新下载 {tiles.fetched}，缺失 {tiles.missing}' if tiles else ''))


if __name__ == '__main__':
    main()

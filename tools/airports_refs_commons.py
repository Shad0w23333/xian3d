"""从 Wikimedia Commons 下载机场参考照片（1280px 缩略图）+ 记录作者与许可证。
输出 research/refs/airport_*.jpg 与 research/refs/airport_refs_credits.json
"""
import json, os, sys, time, urllib.parse
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFS = os.path.join(ROOT, 'research', 'refs')
UA = 'xian3d-research/0.1 (3D city model research; samgp0720 at gmail)'
FILES = {
    'airport_xiy_t5_landside.jpg': "File:20250911 Xi'an Xianyang International Airport - Terminal 5.jpg",
    'airport_xiy_t5_aerial.jpg': "File:Xi'an Xianyang Airport T5 Aerial.jpg",
    'airport_xiy_t5_stand.jpg': "File:20250911 Xi'an Xianyang International Airport - M Stand at Terminal 5.jpg",
    'airport_xiy_t5_interior.jpg': "File:20250911 Xi'an Xianyang International Airport - Interior of Terminal 5 01.jpg",
    'airport_xiy_tower.jpg': "File:20250911 Xi'an Xianyang International Airport - Air Traffic Control Tower.jpg",
    'airport_xiy_t3_landside.jpg': "File:20250911 Xi'an Xianyang International Airport - Terminal 3.jpg",
    'airport_xiy_t3_landside_2022.jpg': "File:Xi'an Xianyang International Airport, Jan 24 2022.jpg",
    'airport_xiy_t3_front.jpg': "File:Xi'an Xianyang International Airport T3 Terminal.jpg",
    'airport_xiy_t3_body.jpg': "File:西安咸阳国际机场T3航站楼的楼身.jpg",
    'airport_xiy_t2_2011.jpg': "File:Terminal 2 of Xi'an Xianyang International Airport(2011).JPG",
    'airport_xiy_t3_night.jpg': "File:Airport, Terminal JP7562176.jpg",
    'airport_xiguan_terminal_1991.jpg': "File:Xi'an Airport Terminal 1991 (10564092125).jpg",
}


def main():
    os.makedirs(REFS, exist_ok=True)
    credits = {}
    cpath = os.path.join(REFS, 'airport_refs_credits.json')
    if os.path.exists(cpath):
        credits = json.load(open(cpath))
    for out, title in FILES.items():
        p = os.path.join(REFS, out)
        if os.path.exists(p) and out in credits:
            continue
        q = {'action': 'query', 'titles': title, 'prop': 'imageinfo', 'iiprop': 'url|extmetadata|size',
             'iiurlwidth': 1280, 'format': 'json'}
        r = requests.get('https://commons.wikimedia.org/w/api.php', params=q, headers={'User-Agent': UA}, timeout=30)
        pages = r.json()['query']['pages']
        pg = next(iter(pages.values()))
        if 'imageinfo' not in pg:
            print('缺失', title)
            continue
        ii = pg['imageinfo'][0]
        url = ii.get('thumburl') or ii['url']
        for a in range(4):
            try:
                img = requests.get(url, headers={'User-Agent': UA}, timeout=60)
                if img.status_code == 200:
                    break
            except Exception:
                pass
            time.sleep(3 * (a + 1))
        open(p, 'wb').write(img.content)
        em = ii.get('extmetadata', {})
        import re
        strip = lambda s: re.sub(r'<[^>]+>', '', s or '').strip()
        credits[out] = {'title': title, 'page': ii.get('descriptionurl'),
                        'artist': strip(em.get('Artist', {}).get('value')),
                        'license': em.get('LicenseShortName', {}).get('value'),
                        'date': strip(em.get('DateTimeOriginal', {}).get('value')),
                        'desc': strip(em.get('ImageDescription', {}).get('value'))[:300]}
        print('完成', out, len(img.content), credits[out]['license'])
        time.sleep(1)
    json.dump(credits, open(cpath, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()

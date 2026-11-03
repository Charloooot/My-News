#!/usr/bin/env python3
"""Refresh the bundled TLE fallback (tle-snapshot.txt + inline <script id="tleSnapshot">).

TLEs drift by kilometres per day, so the offline snapshot should be refreshed
every week or two. Keeps the same satellite selection as the current snapshot
(matched by NORAD id) and pulls fresh elements from CelesTrak's `active` group.

    python3 scripts/refresh-tle.py
"""
import pathlib, re, sys, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SNAP = ROOT / 'tle-snapshot.txt'
HTML = ROOT / 'index.html'
URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle'

def triples(text):
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    out = []
    for i in range(len(lines) - 2):
        if lines[i + 1].startswith('1 ') and lines[i + 2].startswith('2 '):
            out.append((lines[i].strip(), lines[i + 1], lines[i + 2]))
    return out

def norad(l1):
    return l1[2:7].strip()

def main():
    current = triples(SNAP.read_text())
    wanted = [norad(t[1]) for t in current]
    req = urllib.request.Request(URL, headers={'User-Agent': 'wrld-news/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            fresh_text = r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        hint = (' — CelesTrak refuses a repeat download from the same IP within ~2h;'
                ' retry later or from another network') if e.code == 403 else ''
        sys.exit(f'CelesTrak HTTP {e.code}{hint}. Nothing changed.')
    fresh = {norad(t[1]): t for t in triples(fresh_text)}
    if len(fresh) < 1000:
        sys.exit(f'CelesTrak returned only {len(fresh)} sats (rate-limited?): {fresh_text[:120]!r}')

    kept = [fresh[n] for n in wanted if n in fresh]
    dropped = len(wanted) - len(kept)   # decayed / deorbited since last snapshot
    body = '\n'.join('\n'.join(t) for t in kept) + '\n'
    SNAP.write_text(body)

    html = HTML.read_text()
    pat = re.compile(r'(<script type="text/plain" id="tleSnapshot">\n)(.*?)(\s*</script>)', re.S)
    if not pat.search(html):
        sys.exit('inline tleSnapshot block not found in index.html')
    html = pat.sub(lambda m: m.group(1) + body.rstrip('\n') + m.group(3), html, count=1)
    HTML.write_text(html)
    print(f'snapshot refreshed: {len(kept)} sats kept, {dropped} no longer in active group')

if __name__ == '__main__':
    main()

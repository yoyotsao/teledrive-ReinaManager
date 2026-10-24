"""以 HTTP Range 讀取本機 bridge 上的 zip 目錄與少數識別檔，辨認遊戲。

用法：python3 -I probe_zip.py <reina_manager.db> <逗號分隔的遊戲 id>
每行輸出一筆 JSON：top（最上層項目）、exes（執行檔）、hints（從識別檔讀到的標題）。
只讀 zip 結尾的目錄與幾個小檔，不會下載整個遊戲。資料夾型遊戲（沒有 .zip）會回報 404。
識別檔：RPG Maker 的 System.json／Game.ini、Unity 的 *_Data/app.info、
Ren'Py 的 options.rpy、TyranoScript 的 Config.tjs、NW.js 的 package.json。
"""
import io, json, re, sys, sqlite3, zipfile, urllib.request, urllib.parse

# bridge 只在 Windows 本機 loopback 監聽；WSL2 用鏡像網路時也能直接連
BASE = "http://127.0.0.1:8081/game/"

class HttpFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        self.pos = {0: off, 1: self.pos + off, 2: self.size + off}[whence]
        return self.pos
    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0: return 0
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{self.pos+n-1}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        b[:len(data)] = data
        self.pos += len(data)
        return len(data)

def decode_name(info):
    # 非 UTF-8 旗標的檔名多半是 Shift-JIS 或 GBK
    if info.flag_bits & 0x800: return info.filename
    try: raw = info.filename.encode("cp437")
    except UnicodeEncodeError: return info.filename
    for enc in ("utf-8", "cp932", "gbk"):
        try: return raw.decode(enc)
        except UnicodeDecodeError: pass
    return info.filename

ID_FILES = re.compile(r"(^|/)(www/data/System\.json|data/System\.json|Game\.ini|[^/]+_Data/app\.info|game/options\.rpy|data/system/Config\.tjs|package\.json)$", re.I)

def read_text(z, info, limit=200_000):
    if info.file_size > limit: return None
    data = z.read(info)
    for enc in ("utf-8-sig", "cp932", "gbk"):
        try: return data.decode(enc)
        except UnicodeDecodeError: pass
    return None

def extract_hint(path, text):
    p = path.lower()
    if p.endswith("system.json"):
        try: return json.loads(text).get("gameTitle")
        except Exception: return None
    if p.endswith("game.ini"):
        m = re.search(r"^Title=(.*)$", text, re.M); return m and m.group(1).strip()
    if p.endswith("app.info"): return " / ".join(text.split("\n")[:2])
    if p.endswith("options.rpy"):
        m = re.search(r"config\.name\s*=\s*_?\(?\s*[\"'](.+?)[\"']", text); return m and m.group(1)
    if p.endswith("config.tjs"):
        m = re.search(r";System\.title\s*=\s*\"(.+?)\"", text); return m and m.group(1)
    if p.endswith("package.json"):
        try:
            d = json.loads(text); return (d.get("window") or {}).get("title") or d.get("name")
        except Exception: return None

def probe(name):
    url = BASE + urllib.parse.quote(name + ".zip")
    try:
        z = zipfile.ZipFile(io.BufferedReader(HttpFile(url), buffer_size=1 << 16))
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
    infos = z.infolist()
    names = [decode_name(i) for i in infos]
    exes = sorted({n.rsplit("/", 1)[-1] for n in names if n.lower().endswith(".exe")})[:8]
    top = sorted({n.split("/")[0] for n in names})[:10]
    hints = {}
    for info, n in zip(infos, names):
        if ID_FILES.search(n) and n.count("/") <= 3:
            t = read_text(z, info)
            if t:
                h = extract_hint(n, t)
                if h: hints[n] = h
    return {"top": top, "exes": exes, "hints": hints, "files": len(names)}

if __name__ == "__main__":
    db, ids = sys.argv[1], [int(x) for x in sys.argv[2].split(",")]
    c = sqlite3.connect(db)
    out = {}
    for i in ids:
        path = c.execute("select teledrive_path from games where id=?", (i,)).fetchone()[0]
        name = path.split("/", 1)[1]
        try: r = probe(name)
        except Exception as e: r = {"error": f"{type(e).__name__}: {e}"}
        out[i] = {"name": name, **r}
        print(json.dumps({i: out[i]}, ensure_ascii=False), flush=True)

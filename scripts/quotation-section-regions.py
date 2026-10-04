"""Read Poppler bbox XML, emit ordered supply/install introduction regions."""
import json
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
pages = []
anchors = []
for page_no, page in enumerate(root.findall(".//{*}page"), 1):
    width, height = float(page.attrib["width"]), float(page.attrib["height"])
    pages.append({"page": page_no, "width": width, "height": height})
    for line in page.findall(".//{*}line"):
        text = " ".join("".join(w.itertext()) for w in line.findall("{*}word"))
        if "fourniture et pose" in text.lower() and ":" in text:
            anchors.append({"page": page_no, "y": float(line.attrib["yMin"]) / height})
anchors.sort(key=lambda a: (a["page"], a["y"]))
print(json.dumps({"pages": pages, "anchors": anchors}))
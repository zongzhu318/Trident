"""Validate generated appcast metadata before it becomes publicly discoverable."""
import sys
import json
import xml.etree.ElementTree as ET

feed, version, filename = sys.argv[1:]
ns = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
root = ET.parse(feed).getroot()
assert root.tag == "rss", "Expected RSS appcast"
items = root.findall("./channel/item")
matching = [item for item in items if item.findtext(ns + "version") == version]
assert len(matching) == 1, "Expected exactly one matching build version"
item = matching[0]
assert item.findtext(ns + "shortVersionString") == version
assert item.findtext(ns + "minimumSystemVersion"), "Missing macOS requirement"
enclosure = item.find("enclosure")
assert enclosure is not None
assert enclosure.get("url") == f"https://github.com/zongzhu318/Trident/releases/download/v{version}/{filename}"
assert int(enclosure.get("length", "0")) > 0
assert enclosure.get(ns + "edSignature"), "Missing update signature"
assert not root.findall(".//" + ns + "deltas"), "Delta updates not supported in this release pipeline"
print(json.dumps({"signature": enclosure.get(ns + "edSignature"), "length": int(enclosure.get("length"))}))

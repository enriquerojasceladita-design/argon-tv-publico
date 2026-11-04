/* Lector de listas M3U. Devuelve [{name, group, logo, url}] */
function parseM3U(text) {
  "use strict";
  var out = [];
  var lines = String(text).split(/\r?\n/);
  var cur = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf("#EXTINF") === 0) {
      var comma = line.lastIndexOf(",");
      var g = /group-title="([^"]*)"/.exec(line);
      var l = /tvg-logo="([^"]*)"/.exec(line);
      var t = /tvg-id="([^"]*)"/.exec(line);
      cur = {
        name: comma >= 0 ? line.slice(comma + 1).trim() : "Sin nombre",
        group: g ? g[1] : "",
        logo: l ? l[1] : "",
        tid: t ? t[1] : "",
        url: ""
      };
    } else if (line.charAt(0) !== "#") {
      if (cur && /^https?:\/\//i.test(line)) {
        cur.url = line;
        out.push(cur);
      }
      cur = null;
    }
  }
  return out;
}
if (typeof module !== "undefined") module.exports = { parseM3U: parseM3U };

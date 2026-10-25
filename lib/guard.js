'use strict';

/*
  הגנות משותפות לפונקציות השרת: אותו אתר בלבד, וזיהוי כתובת הרשת של הפונה
  והגבלת קצב בסיסית (בזיכרון של המופע).
*/

function clientIp(req) {
  const raw = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] ||
    (req.socket && req.socket.remoteAddress) || '';
  return String(raw).split(',')[0].trim() || 'unknown';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === String(host).split(',')[0].trim();
  } catch (e) {
    return false;
  }
}

// יוצר מגביל קצב: עד perIp בקשות לכתובת בחלון זמן, ועד globalMax בשעה לכל המופע
function makeRateLimiter({ windowMs, perIp, globalMax }) {
  const hits = new Map();
  let global = [];
  return function limited(ip) {
    const now = Date.now();
    global = global.filter((t) => now - t < 60 * 60 * 1000);
    if (global.length >= globalMax) return true;
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= perIp) {
      hits.set(ip, recent);
      return true;
    }
    recent.push(now);
    hits.set(ip, recent);
    global.push(now);
    if (hits.size > 500) {
      for (const [key, arr] of hits) {
        if (!arr.some((t) => now - t < windowMs)) hits.delete(key);
      }
    }
    return false;
  };
}

module.exports = { clientIp, sameOrigin, makeRateLimiter };

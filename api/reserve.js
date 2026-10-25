'use strict';

/*
  api/reserve.js
  --------------------------------------------------------------
  נקראת ברגע שהלקוח לוחץ "שלח הזמנה", לפני הכנת המסמך הסופי.
  מקצה מספר אסמכתא רץ וקצר (T-1001, T-1002 ...) מתוך מסד הנתונים.
  אם מסד הנתונים לא זמין — מחזירה תשובה מסודרת, והטופס ממשיך עם מספר זמני.
*/

const { reserveRef } = require('../lib/db');
const { clientIp, sameOrigin, makeRateLimiter } = require('../lib/guard');

const limited = makeRateLimiter({ windowMs: 15 * 60 * 1000, perIp: 10, globalMax: 120 });

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'origin' });
  if (limited(clientIp(req))) return res.status(429).json({ ok: false, error: 'rate' });

  try {
    const ref = await reserveRef();
    if (!ref) return res.status(200).json({ ok: false, error: 'db_unavailable' });
    return res.status(200).json({ ok: true, ref });
  } catch (err) {
    console.error('reserve: הקצאת מספר אסמכתא נכשלה:', err && (err.code || ''), err && err.message);
    return res.status(200).json({ ok: false, error: 'db_unavailable' });
  }
};

'use strict';

/*
  api/stamp.js
  --------------------------------------------------------------
  נקראת ברגע שהלקוח מאשר את החתימה שלו.
  מחזירה מספר הזמנה ותאריך ושעה לפי השעון של השרת (ולא של המכשיר),
  כדי שחותמת הזמן שמופיעה במסמך החתום תהיה אמינה.
  אין כאן שום מידע רגיש ושום שליחת מייל.
*/

const { formatIsrael, newOrderNumber } = require('../lib/shared');

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  const now = new Date();
  return res.status(200).json({
    ok: true,
    orderNo: newOrderNumber(now),
    signedAt: now.toISOString(),
    signedAtDisplay: formatIsrael(now)
  });
};

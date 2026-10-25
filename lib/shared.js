'use strict';

/*
  פונקציות משותפות לשתי פונקציות השרת (api/stamp.js ו-api/send-order.js).
*/

const crypto = require('crypto');

const TIME_ZONE = 'Asia/Jerusalem';

// תאריך ושעה בפורמט DD/MM/YYYY HH:MM לפי שעון ישראל
function formatIsrael(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('day')}/${get('month')}/${get('year')} ${hour}:${get('minute')}`;
}

// מספר הזמנה: HL-YYMMDD-XXXXX (בלי תווים שמתבלבלים: 0/O, 1/I)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newOrderNumber(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: '2-digit', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  let suffix = '';
  for (let i = 0; i < 5; i++) suffix += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `HL-${get('year')}${get('month')}${get('day')}-${suffix}`;
}

const ORDER_NO_RE = /^HL-\d{6}-[A-Z2-9]{5}$/;
// מספר אסמכתא רץ מהמסד (T-1001) — או מספר זמני כשהמסד לא זמין (HL-...)
const REF_RE = /^T-\d{4,9}$/;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { formatIsrael, newOrderNumber, ORDER_NO_RE, REF_RE, escapeHtml, TIME_ZONE };

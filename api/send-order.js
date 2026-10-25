'use strict';

/*
  api/send-order.js
  --------------------------------------------------------------
  מקבלת מהטופס הזמנה חתומה (פרטים + קובץ PDF) ושולחת:
    1. מייל אליך, עם ההזמנה החתומה מצורפת ופרטי תיעוד (זמן, מכשיר, כתובת רשת).
    2. עותק ללקוח, לכתובת הדוא"ל שהוא הזין בטופס.

  השליחה נעשית דרך חשבון הג'ימייל שלך, באמצעות "סיסמת אפליקציה".
  הסיסמה לא נמצאת בקוד אלא בהגדרות הפרויקט בוורסל בלבד.

  משתני סביבה (Settings -> Environment Variables בפרויקט בוורסל):
    GMAIL_USER           כתובת הג'ימייל ממנה נשלחים המיילים
    GMAIL_APP_PASSWORD   סיסמת האפליקציה (16 תווים, אפשר עם או בלי רווחים)
    OWNER_EMAIL          אופציונלי: לאן מגיעות ההזמנות. אם לא הוגדר - אל GMAIL_USER
    SUPABASE_URL, SUPABASE_SECRET_KEY
                         אופציונלי: רישום ההזמנה גם במערכת הניהול (ממתינה לאישור).
                         אם לא הוגדרו — ההזמנה נשלחת במייל בלבד.
*/

const nodemailer = require('nodemailer');
const { formatIsrael, ORDER_NO_RE, REF_RE, escapeHtml } = require('../lib/shared');
const { clientIp, sameOrigin, makeRateLimiter } = require('../lib/guard');
const { submitIncoming } = require('../lib/db');

// פרטי קשר שמופיעים בעותק שנשלח ללקוח
const CONTACT_PHONE = '050-5274030';
const COMPANY_NAME = 'חטיפי למידה';
const COMPANY_LEGAL = 'חנציס דוד, ניהול והשקעות בע"מ';

// מגבלות
const MAX_PDF_BYTES = 3.2 * 1024 * 1024; // ~3.2MB (המגבלה בוורסל לגוף בקשה: 4.5MB כולל קידוד)
const MIN_PDF_BYTES = 1024;
const MAX_CLOCK_GAP_MS = 2 * 60 * 60 * 1000; // פער זמן מקסימלי בין החתימה לשליחה לפני שמסמנים

// הגבלת קצב בסיסית (בזיכרון של המופע, כהגנה בסיסית מפני ניצול לרעה)
const rateLimited = makeRateLimiter({ windowMs: 15 * 60 * 1000, perIp: 6, globalMax: 60 });

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;

/* ------------------------------------------------------------
   עזרים
   ------------------------------------------------------------ */
function clean(value) {
  // מסיר תווי בקרה (למניעת הזרקת שורות לכותרות המייל)
  return String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
}

function text(value, { min = 0, max = 200 } = {}) {
  if (typeof value !== 'string') return min === 0 && value == null ? '' : null;
  const v = clean(value);
  if (v.length < min || v.length > max) return null;
  return v;
}

function displayDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function shekel(n) {
  return `${Number(n).toLocaleString('he-IL')} ש"ח`;
}

/* ------------------------------------------------------------
   בדיקת תקינות הקלט
   ------------------------------------------------------------ */
function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return null; }
  }
  return body && typeof body === 'object' ? body : null;
}

function validate(body) {
  const fail = (field) => ({ ok: false, field });

  // מספר אסמכתא: רץ מהמסד (T-1001) או זמני (HL-...) כשהמסד לא זמין
  const ref = typeof body.ref === 'string' ? body.ref : (typeof body.orderNo === 'string' ? body.orderNo : '');
  if (!REF_RE.test(ref) && !ORDER_NO_RE.test(ref)) return fail('ref');

  const signedAt = new Date(body.signedAt);
  if (!body.signedAt || Number.isNaN(signedAt.getTime())) return fail('signedAt');

  const timeSource = body.timeSource === 'device' ? 'device' : 'server';

  const o = body.order || {};
  const s = body.signer || {};

  const schoolName = text(o.schoolName, { min: 1, max: 120 });
  if (schoolName === null) return fail('schoolName');
  const schoolSymbol = text(o.schoolSymbol, { min: 1, max: 30 });
  if (schoolSymbol === null) return fail('schoolSymbol');
  const principalName = text(o.principalName, { min: 1, max: 100 });
  if (principalName === null) return fail('principalName');
  const ordererRole = text(o.ordererRole, { max: 100 });
  if (ordererRole === null) return fail('ordererRole');
  const phone = text(o.phone, { max: 30 });
  if (phone === null) return fail('phone');
  const city = text(o.city, { max: 100 });
  if (city === null) return fail('city');

  const email = text(o.email, { min: 3, max: 120 });
  if (email === null || !EMAIL_RE.test(email)) return fail('email');

  const orderDate = typeof o.orderDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.orderDate) ? o.orderDate : null;
  if (!orderDate) return fail('orderDate');

  if (!Array.isArray(o.courses) || o.courses.length < 1 || o.courses.length > 30) return fail('courses');
  const courses = [];
  for (const c of o.courses) {
    const name = text(c && c.name, { min: 1, max: 150 });
    const price = c && Number(c.price);
    if (name === null || !Number.isFinite(price) || price < 0 || price > 200000) return fail('courses');
    courses.push({ name, price: Math.round(price) });
  }

  const signerName = text(s.name, { min: 1, max: 100 });
  if (signerName === null) return fail('signerName');
  const signerRole = text(s.role, { min: 1, max: 100 });
  if (signerRole === null) return fail('signerRole');

  if (body.consent !== true) return fail('consent');

  if (typeof body.pdfBase64 !== 'string') return fail('pdf');
  const b64 = body.pdfBase64.replace(/^data:application\/pdf;(?:[a-z0-9=\-]+;)*base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return fail('pdf');
  const pdf = Buffer.from(b64, 'base64');
  if (pdf.length < MIN_PDF_BYTES || pdf.length > MAX_PDF_BYTES) return fail('pdf');
  if (pdf.slice(0, 5).toString('latin1') !== '%PDF-') return fail('pdf');

  return {
    ok: true,
    data: {
      ref, signedAt, timeSource,
      orderDate, schoolName, schoolSymbol, principalName, ordererRole, phone, email, city,
      courses, total: courses.reduce((sum, c) => sum + c.price, 0),
      signerName, signerRole, pdf
    }
  };
}

/* ------------------------------------------------------------
   בניית המיילים
   ------------------------------------------------------------ */
const FONT = "Arial, Helvetica, sans-serif";

function row(label, value) {
  if (!value) return '';
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #e3e8ee;color:#1a5276;font-weight:700;white-space:nowrap;width:34%;">${escapeHtml(label)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e3e8ee;">${escapeHtml(value)}</td>
  </tr>`;
}

function coursesTable(d) {
  const rows = d.courses.map((c, i) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e3e8ee;width:30px;text-align:center;color:#5d6d7e;">${i + 1}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e3e8ee;">${escapeHtml(c.name)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e3e8ee;white-space:nowrap;text-align:left;">${escapeHtml(shekel(c.price))}</td>
    </tr>`).join('');
  return `<table dir="rtl" style="width:100%;border-collapse:collapse;font-size:14px;margin:6px 0 4px;">
    ${rows}
    <tr>
      <td colspan="2" style="padding:8px 10px;font-weight:700;color:#1a5276;">סה"כ (כולל מע"מ)</td>
      <td style="padding:8px 10px;font-weight:700;color:#1a5276;white-space:nowrap;text-align:left;">${escapeHtml(shekel(d.total))}</td>
    </tr>
  </table>`;
}

function ownerMail(d, meta) {
  const signedLabel = d.timeSource === 'device'
    ? `${meta.signedAtDisplay} (לפי שעון המכשיר של הלקוח)`
    : meta.signedAtDisplay;

  const notes = [];
  if (d.timeSource === 'device') notes.push('חותמת הזמן נלקחה משעון המכשיר של הלקוח ולא מהשרת.');
  if (meta.clockGap) notes.push('יש פער של יותר משעתיים בין שעת החתימה לשעת השליחה.');
  const regHtml = meta.registered
    ? `<div style="background:#eafaf1;border:1px solid #27ae60;border-radius:6px;padding:8px 12px;margin:12px 0;font-size:14px;">✅ ההזמנה ממתינה לאישורך במערכת הניהול, במסך "הזמנות מהטופס".</div>`
    : `<div style="background:#fdf0ef;border:1px solid #c0392b;border-radius:6px;padding:8px 12px;margin:12px 0;font-size:14px;">⚠️ ההזמנה לא נרשמה אוטומטית במערכת הניהול. יש להזין אותה ידנית.</div>`;
  const noteHtml = notes.length
    ? `<div style="background:#fef9e7;border:1px solid #f0c040;border-radius:6px;padding:8px 12px;margin:12px 0;font-size:13px;">⚠️ ${notes.map(escapeHtml).join('<br>⚠️ ')}</div>`
    : '';

  const html = `<div dir="rtl" style="font-family:${FONT};font-size:15px;color:#1c2833;line-height:1.6;max-width:640px;">
  <h2 style="color:#1a5276;margin:0 0 6px;">התקבלה הזמנה חדשה</h2>
  <div style="margin-bottom:10px;">מספר אסמכתא: <strong>${escapeHtml(d.ref)}</strong> &nbsp;|&nbsp; ההזמנה החתומה מצורפת למייל כקובץ PDF.</div>
  ${regHtml}
  ${noteHtml}
  <table dir="rtl" style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:10px;">
    ${row('בית ספר', d.schoolName)}
    ${row('סמל מוסד', d.schoolSymbol)}
    ${row('חותם/ת', `${d.signerName}, ${d.signerRole}`)}
    ${row('שם מנהל/ת', d.principalName)}
    ${row('תפקיד המזמין/ה', d.ordererRole)}
    ${row('טלפון', d.phone)}
    ${row('דוא"ל', d.email)}
    ${row('עיר / רשות', d.city)}
    ${row('תאריך ההזמנה', displayDate(d.orderDate))}
    ${row('נחתם בתאריך ושעה', signedLabel)}
  </table>
  ${coursesTable(d)}
  <div style="margin-top:16px;padding-top:10px;border-top:1px solid #e3e8ee;font-size:12px;color:#7f8c8d;">
    נתוני תיעוד: התקבל בשרת ב-${escapeHtml(meta.receivedAtDisplay)} &nbsp;|&nbsp; כתובת רשת: ${escapeHtml(meta.ip)}<br>
    מכשיר: ${escapeHtml(meta.userAgent)}
  </div>
</div>`;

  const lines = [
    `התקבלה הזמנה חדשה - ${d.ref}`,
    meta.registered ? 'ההזמנה ממתינה לאישורך במערכת הניהול, במסך "הזמנות מהטופס".' : 'שימו לב: ההזמנה לא נרשמה אוטומטית במערכת הניהול. יש להזין אותה ידנית.',
    '',
    `בית ספר: ${d.schoolName} (סמל מוסד ${d.schoolSymbol})`,
    `חותם/ת: ${d.signerName}, ${d.signerRole}`,
    `שם מנהל/ת: ${d.principalName}`,
    d.ordererRole ? `תפקיד המזמין/ה: ${d.ordererRole}` : '',
    d.phone ? `טלפון: ${d.phone}` : '',
    `דוא"ל: ${d.email}`,
    d.city ? `עיר / רשות: ${d.city}` : '',
    `נחתם בתאריך ושעה: ${signedLabel}`,
    '',
    'קורסים:',
    ...d.courses.map((c, i) => `${i + 1}. ${c.name} - ${shekel(c.price)}`),
    `סה"כ (כולל מע"מ): ${shekel(d.total)}`,
    '',
    ...notes,
    `התקבל בשרת: ${meta.receivedAtDisplay} | כתובת רשת: ${meta.ip}`
  ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '');

  return { html, text: lines.join('\n') };
}

function customerMail(d, meta) {
  const html = `<div dir="rtl" style="font-family:${FONT};font-size:15px;color:#1c2833;line-height:1.7;max-width:600px;">
  <h2 style="color:#1a5276;margin:0 0 8px;">תודה, ההזמנה התקבלה</h2>
  <p style="margin:0 0 10px;">שלום ${escapeHtml(d.signerName)},</p>
  <p style="margin:0 0 10px;">ההזמנה של <strong>${escapeHtml(d.schoolName)}</strong> התקבלה אצלנו.
  מצורף עותק של ההזמנה החתומה לשמירה אצלכם (מספר אסמכתא: <strong>${escapeHtml(d.ref)}</strong>, נחתם בתאריך ${escapeHtml(meta.signedAtDisplay)}).</p>
  ${coursesTable(d)}
  <p style="margin:16px 0 0;">לשאלות אפשר להשיב למייל זה או להתקשר: <strong>${escapeHtml(CONTACT_PHONE)}</strong></p>
  <p style="margin:16px 0 0;color:#5d6d7e;font-size:13px;">${escapeHtml(COMPANY_NAME)} | ${escapeHtml(COMPANY_LEGAL)}</p>
</div>`;

  const lines = [
    `שלום ${d.signerName},`,
    '',
    `ההזמנה של ${d.schoolName} התקבלה אצלנו.`,
    `מצורף עותק של ההזמנה החתומה לשמירה אצלכם (מספר אסמכתא: ${d.ref}, נחתם בתאריך ${meta.signedAtDisplay}).`,
    '',
    ...d.courses.map((c, i) => `${i + 1}. ${c.name} - ${shekel(c.price)}`),
    `סה"כ (כולל מע"מ): ${shekel(d.total)}`,
    '',
    `לשאלות אפשר להשיב למייל זה או להתקשר: ${CONTACT_PHONE}`,
    `${COMPANY_NAME} | ${COMPANY_LEGAL}`
  ];
  return { html, text: lines.join('\n') };
}

/* ------------------------------------------------------------
   הפונקציה הראשית
   ------------------------------------------------------------ */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }
  if (!sameOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'origin' });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'rate' });
  }

  const body = parseBody(req);
  if (!body) return res.status(400).json({ ok: false, error: 'invalid', field: 'body' });

  // שדה מלכודת לרובוטים: בני אדם לא רואים אותו ולא ממלאים אותו
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return res.status(200).json({ ok: true, ref: String(body.ref || body.orderNo || ''), customerCopy: false });
  }

  const checked = validate(body);
  if (!checked.ok) {
    return res.status(400).json({ ok: false, error: 'invalid', field: checked.field });
  }
  const d = checked.data;

  const user = (process.env.GMAIL_USER || '').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const owner = (process.env.OWNER_EMAIL || '').trim() || user;
  if (!user || !pass || !EMAIL_RE.test(owner)) {
    console.error('send-order: חסרות הגדרות סביבה (GMAIL_USER / GMAIL_APP_PASSWORD)');
    return res.status(500).json({ ok: false, error: 'server_not_configured' });
  }

  const now = new Date();
  const meta = {
    ip,
    userAgent: clean(req.headers['user-agent'] || '').slice(0, 200),
    receivedAtDisplay: formatIsrael(now),
    signedAtDisplay: formatIsrael(d.signedAt),
    clockGap: Math.abs(now.getTime() - d.signedAt.getTime()) > MAX_CLOCK_GAP_MS
  };

  // רישום במערכת הניהול (ממתינה לאישור). כישלון כאן לא עוצר את המייל — המייל הוא רשת הביטחון.
  meta.registered = false;
  if (REF_RE.test(d.ref)) {
    try {
      const r = await submitIncoming(d.ref, d, meta);
      meta.registered = !!r.saved;
      if (!r.saved) console.error('send-order: ההזמנה לא נרשמה במסד:', r.reason);
    } catch (err) {
      console.error('send-order: רישום במסד נכשל:', err && (err.code || err.statusCode || ''), err && err.message);
    }
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 25000
  });

  const attachment = {
    filename: `Order-${d.ref}.pdf`,
    content: d.pdf,
    contentType: 'application/pdf'
  };
  const from = { name: COMPANY_NAME, address: user };

  try {
    // 1. מייל אליך - אם זה נכשל, ההזמנה לא נחשבת כנשלחה
    const toOwner = ownerMail(d, meta);
    await transporter.sendMail({
      from,
      to: owner,
      replyTo: d.email,
      subject: clean(`הזמנה חדשה ${d.ref} - ${d.schoolName}`),
      text: toOwner.text,
      html: toOwner.html,
      attachments: [attachment]
    });
  } catch (err) {
    console.error('send-order: שליחה אל בעל העסק נכשלה:', err && err.code, err && err.message);
    try { transporter.close(); } catch (e) { /* ignore */ }
    return res.status(502).json({ ok: false, error: 'send_failed' });
  }

  // 2. עותק ללקוח - כישלון כאן לא מבטל את ההזמנה (למשל כתובת עם שגיאת הקלדה)
  let customerCopy = true;
  try {
    const toCustomer = customerMail(d, meta);
    await transporter.sendMail({
      from,
      to: d.email,
      replyTo: owner,
      subject: clean(`עותק הזמנה ${d.ref} - ${COMPANY_NAME}`),
      text: toCustomer.text,
      html: toCustomer.html,
      attachments: [attachment]
    });
  } catch (err) {
    customerCopy = false;
    console.error('send-order: שליחת עותק ללקוח נכשלה:', err && err.code, err && err.message);
  }

  try { transporter.close(); } catch (e) { /* ignore */ }

  return res.status(200).json({
    ok: true,
    ref: d.ref,
    registered: meta.registered,
    customerCopy,
    receivedAtDisplay: meta.receivedAtDisplay
  });
};

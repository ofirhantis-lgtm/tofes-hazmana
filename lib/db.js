'use strict';

/*
  חיבור למסד הנתונים של מערכת הניהול (Supabase) — מצד השרת בלבד.
  המפתח הסודי נמצא רק בהגדרות הפרויקט בוורסל, לעולם לא בדף עצמו.

  משתני סביבה:
    SUPABASE_URL          כתובת הפרויקט (אותה כתובת שמופיעה במערכת הניהול)
    SUPABASE_SECRET_KEY   המפתח הסודי של הפרויקט (מתחיל ב-sb_secret_)

  אם אחד מהם חסר — הטופס ממשיך לעבוד כרגיל (מייל בלבד, עם מספר אסמכתא זמני).
*/

const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'order-files';
const TABLE = 'incoming_orders';

let cached = null;

function getDb() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SECRET_KEY || '').trim();
  if (!url || !key) return null;
  if (!cached || cached.url !== url || cached.key !== key) {
    cached = {
      url, key,
      client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    };
  }
  return cached.client;
}

// מקצה מספר אסמכתא רץ חדש (T-1001 ...). מחזיר null אם אין חיבור או שהפעולה נכשלה.
async function reserveRef() {
  const db = getDb();
  if (!db) return null;
  const { data, error } = await db.rpc('reserve_incoming_ref');
  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

// שומר את ההזמנה המלאה + המסמך החתום. מחזיר { saved: true, path } או זורק שגיאה.
async function submitIncoming(ref, d, meta) {
  const db = getDb();
  if (!db) return { saved: false, reason: 'not_configured' };

  const path = `incoming/${ref}.pdf`;
  const up = await db.storage.from(BUCKET).upload(path, d.pdf, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw up.error;

  const row = {
    status: 'pending',
    submitted_at: new Date().toISOString(),
    signed_at: d.signedAt.toISOString(),
    time_source: d.timeSource,
    order_date: d.orderDate,
    school_name: d.schoolName,
    school_symbol: d.schoolSymbol,
    principal_name: d.principalName,
    orderer_role: d.ordererRole,
    phone: d.phone,
    email: d.email,
    city: d.city,
    courses: d.courses,
    total: d.total,
    signer_name: d.signerName,
    signer_role: d.signerRole,
    pdf_path: path,
    pdf_size: d.pdf.length,
    client_ip: meta.ip,
    user_agent: meta.userAgent
  };

  // מעדכן רק שורה שעדיין לא טופלה (שמורה, או ממתינה — בשליחה חוזרת). הזמנה שאושרה/נדחתה לא תידרס.
  const { data, error } = await db.from(TABLE).update(row).eq('ref_num', ref).in('status', ['reserved', 'pending']).select('id');
  if (error) throw error;
  if (!data || !data.length) return { saved: false, reason: 'ref_not_open' };
  return { saved: true, path };
}

module.exports = { getDb, reserveRef, submitIncoming };

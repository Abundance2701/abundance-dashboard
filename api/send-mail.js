/* POST /api/send-mail
   Body (JSON): { to, cc, bcc, subject, html, fileName, pdfBase64 }
   Uploads the PDF to Zoho Mail as an attachment, then sends the email from
   FROM_ADDRESS. The sender address is fixed in Vercel, never taken from the page. */

const { env, urls, accessToken, passcodeOk, reply, jsonBody, emailList } = require('./_zoho');

const MAX_PDF = 3.2 * 1024 * 1024;     // Vercel accepts ~4.5 MB per request; base64 adds a third

async function zoho(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  const ok = r.ok && (!j.status || Number(j.status.code) === 200);
  if (!ok) {
    const why = (j.data && (j.data.moreInfo || j.data.errorCode)) || (j.status && j.status.description) || r.status;
    throw new Error(String(why));
  }
  return j;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.' });
  if (!passcodeOk(req)) return reply(res, 401, { error: 'Passcode did not match.' });

  const ACC = env('ZOHO_MAIL_ACCOUNT_ID'), FROM = env('FROM_ADDRESS');
  if (!ACC || !FROM) return reply(res, 500, { error: 'Setup incomplete: add ZOHO_MAIL_ACCOUNT_ID and FROM_ADDRESS in Vercel and redeploy.' });

  let b, to, cc, bcc, pdf, fileName, subject;
  try {
    b = await jsonBody(req);
    to = emailList(b.to, 'To');
    cc = emailList(b.cc, 'Cc');
    bcc = emailList(b.bcc, 'Bcc');
    if (!to.length) throw new Error('Add at least one email address in To.');
    if (to.length + cc.length + bcc.length > 10) throw new Error('Up to 10 recipients in total.');
    subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'Investment Portfolio';
    fileName = String(b.fileName || 'Investment Portfolio.pdf').replace(/[\\/:*?"<>|\r\n]+/g, '-').trim().slice(0, 150);
    if (!/\.pdf$/i.test(fileName)) fileName += '.pdf';
    pdf = Buffer.from(String(b.pdfBase64 || ''), 'base64');
    if (pdf.length < 100 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('The attachment is not a valid PDF.');
    if (pdf.length > MAX_PDF) throw new Error('The PDF is too large to email. Save to WorkDrive and share the link instead.');
    if (typeof b.html !== 'string' || !b.html.trim()) throw new Error('The message is empty.');
  } catch (e) {
    return reply(res, 400, { error: e.message || 'Could not read the request.' });
  }

  try {
    const token = await accessToken();
    const auth = { Authorization: `Zoho-oauthtoken ${token}` };

    // 1. upload the PDF
    const up = await zoho(
      `${urls().mail}/api/accounts/${ACC}/messages/attachments?fileName=${encodeURIComponent(fileName)}`,
      { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: pdf }
    );
    const att = Array.isArray(up.data) ? up.data[0] : up.data;
    if (!att || !att.storeName || !att.attachmentPath) throw new Error('Zoho did not accept the attachment.');

    // 2. send the email with it
    const mail = {
      fromAddress: FROM,
      toAddress: to.join(','),
      subject,
      content: b.html,
      mailFormat: 'html',
      askReceipt: 'no',
      attachments: [{ storeName: att.storeName, attachmentPath: att.attachmentPath, attachmentName: att.attachmentName || fileName }],
    };
    if (cc.length) mail.ccAddress = cc.join(',');
    if (bcc.length) mail.bccAddress = bcc.join(',');
    /* Send the display name explicitly ("Abundance India <service@…>"), because API
       sends don't always pick up the name set in Zoho Mail. If Zoho won't accept
       that form, send again with the plain address so the email still goes. */
    const NAME = (env('FROM_NAME') || 'Abundance India').replace(/[<>"\r\n]/g, '');
    const post = from => zoho(`${urls().mail}/api/accounts/${ACC}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...mail, fromAddress: from }),
    });
    try { await post(`"${NAME}" <${FROM}>`); }
    catch (e) { await post(FROM); }

    return reply(res, 200, { ok: true, to, cc, bcc });
  } catch (e) {
    return reply(res, 502, { error: `Zoho Mail did not send it: ${e.message || 'unknown error'}.` });
  }
};

// pages/api/missive-inbound.js
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('ok');
  }
  return res.status(200).json({ ok: true });
}

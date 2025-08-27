// api/missive-inbound.js
module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('ok');
  return res.status(200).json({ok:true});
};

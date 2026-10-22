const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { email } = JSON.parse(event.body);
  if (!email) {
    return { statusCode: 400, body: 'Email requerido' };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
  const body = JSON.stringify({ email, unsubscribed: false });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.resend.com',
      path: `/audiences/${AUDIENCE_ID}/contacts`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 200 || res.statusCode === 201) {
        resolve({ statusCode: 200, body: 'Suscrito correctamente' });
      } else {
        resolve({ statusCode: 500, body: 'Error al suscribir' });
      }
    });

    req.on('error', () => {
      resolve({ statusCode: 500, body: 'Error de conexión' });
    });

    req.write(body);
    req.end();
  });
};

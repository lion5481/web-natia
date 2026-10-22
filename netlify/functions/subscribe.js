const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let email;
  try {
    const parsed = JSON.parse(event.body);
    email = parsed.email;
  } catch(e) {
    return { statusCode: 400, body: 'JSON invalido: ' + e.message };
  }

  if (!email) {
    return { statusCode: 400, body: 'Email requerido' };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;

  if (!RESEND_API_KEY) {
    return { statusCode: 500, body: 'Falta RESEND_API_KEY' };
  }

  if (!AUDIENCE_ID) {
    return { statusCode: 500, body: 'Falta RESEND_AUDIENCE_ID' };
  }

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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: data
        });
      });
    });

    req.on('error', (e) => {
      resolve({ 
        statusCode: 500, 
        body: 'Error conexion: ' + e.message 
      });
    });

    req.write(body);
    req.end();
  });
};

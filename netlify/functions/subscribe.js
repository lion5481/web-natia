const RESEND_API_KEY = process.env.RESEND_API_KEY;
const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { email } = JSON.parse(event.body);

  if (!email) {
    return { statusCode: 400, body: "Email requerido" };
  }

  const response = await fetch(
    `https://api.resend.com/audiences/${AUDIENCE_ID}/contacts`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: email,
        unsubscribed: false
      })
    }
  );

  if (response.ok) {
    return { statusCode: 200, body: "Suscrito correctamente" };
  } else {
    return { statusCode: 500, body: "Error al suscribir" };
  }
};
